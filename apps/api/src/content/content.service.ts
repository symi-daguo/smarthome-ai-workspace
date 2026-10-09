import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module.js';
import { FIELD_SPECS } from './extractors/fields.js';
import { runExtraction } from './extractors/pipeline.js';
import type { DocType } from './extractors/types.js';
import { LlmService } from '../llm/llm.service.js';
import { syncProductFromDocument, type ProductDocFields } from '../layout/product-sync.js';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const ALLOWED_EXT = ['txt', 'md', 'csv', 'json', 'html', 'htm', 'docx', 'xlsx', 'pdf'];

@Injectable()
export class ContentService {
  private readonly logger = new Logger(ContentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
  ) {}

  assertFile(file?: Express.Multer.File): void {
    if (!file) throw new BadRequestException('FILE_REQUIRED');
    if (file.size > MAX_UPLOAD_BYTES) throw new BadRequestException('FILE_TOO_LARGE');
    const ext = file.originalname.split('.').pop()?.toLowerCase() ?? '';
    if (!ALLOWED_EXT.includes(ext)) {
      throw new BadRequestException(`FILE_TYPE_UNSUPPORTED: 支持 ${ALLOWED_EXT.join('/')}`);
    }
  }

  /** 三源统一入口：建 job -> 执行管道 -> 落库抽取结果（状态 REVIEWING / FAILED） */
  async run(opts: {
    tenantId: string;
    userId: string;
    source: 'UPLOAD' | 'URL' | 'TRANSCRIPT';
    sourceRef: string;
    docType: DocType;
    text?: string;
    file?: Express.Multer.File;
  }) {
    const job = await this.prisma.extractionJob.create({
      data: {
        tenantId: opts.tenantId,
        createdById: opts.userId,
        source: opts.source,
        sourceRef: opts.sourceRef,
        status: 'EXTRACTING',
      },
    });

    try {
      const result = await runExtraction(
        {
          source: opts.source,
          sourceRef: opts.sourceRef,
          docType: opts.docType,
          text: opts.text,
          file: opts.file ? { buffer: opts.file.buffer, originalName: opts.file.originalname, mimeType: opts.file.mimetype } : undefined,
        },
        this.llm,
      );

      await this.prisma.$transaction(async (tx) => {
        const doc = await tx.extractedDocument.create({
          data: {
            jobId: job.id,
            tenantId: opts.tenantId,
            docType: result.docType,
            title: result.title.slice(0, 200),
            content: result.content,
            fields: {
              create: result.fields.map((f) => ({
                key: f.key,
                label: f.label,
                value: f.value,
                required: f.required,
                confidence: f.confidence,
              })),
            },
          },
        });
        if (result.deficiencies.length > 0) {
          await tx.extractionDeficiency.createMany({
            data: result.deficiencies.map((d) => ({
              jobId: job.id,
              fieldKey: d.fieldKey,
              label: d.label,
              reason: d.reason,
            })),
          });
        }
        await tx.extractionJob.update({
          where: { id: job.id },
          data: { score: result.score, status: result.deficiencies.length > 0 ? 'REVIEWING' : 'CONFIRMED' },
        });
        // 无缺失字段时自动确认入库
        if (result.deficiencies.length === 0) {
          await tx.extractedDocument.update({ where: { id: doc.id }, data: { confirmed: true } });
        }
      });

      // 产品资料确认后同步到产品中心（知识库 <-> 产品库对应；失败降级不阻塞提取链路）
      if (result.docType === 'product' && result.deficiencies.length === 0) {
        try {
          await syncProductFromDocument(
            this.prisma,
            opts.tenantId,
            Object.fromEntries(result.fields.map((f) => [f.key, f.value])) as ProductDocFields,
            result.content,
          );
        } catch (e) {
          this.logger.warn(`产品同步失败（已降级）: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      return this.detail(opts.tenantId, job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`提取失败 job=${job.id}: ${message}`);
      await this.prisma.extractionJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', error: message.slice(0, 500) },
      });
      throw new BadRequestException(message);
    }
  }

  async list(tenantId: string) {
    return this.prisma.extractionJob.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        deficiencies: { where: { resolved: false }, select: { id: true } },
        document: { select: { id: true, title: true, confirmed: true, docType: true } },
      },
    });
  }

  async detail(tenantId: string, jobId: string) {
    const job = await this.prisma.extractionJob.findFirst({
      where: { id: jobId, tenantId },
      include: {
        document: { include: { fields: { orderBy: { key: 'asc' } } } },
        deficiencies: { orderBy: { createdAt: 'asc' } },
        review: true,
      },
    });
    if (!job) throw new NotFoundException('EXTRACTION_JOB_NOT_FOUND');
    // 字段按文档类型的规格顺序展示（字母序对中文用户不直观）
    if (job.document) {
      const order = FIELD_SPECS[job.document.docType as DocType].map((s) => s.key);
      job.document.fields.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    }
    return job;
  }

  /** 已确认入库的文档（供 S4 知识库复用） */
  async listDocuments(tenantId: string) {
    return this.prisma.extractedDocument.findMany({
      where: { tenantId, confirmed: true },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        title: true,
        docType: true,
        updatedAt: true,
        job: { select: { source: true, sourceRef: true, score: true } },
        fields: { select: { key: true, label: true, value: true } },
      },
    });
  }

  /** 用户补全/修正字段后确认入库，deficiency 按字段收敛 */
  async confirm(
    tenantId: string,
    jobId: string,
    userId: string,
    input: { fields: Record<string, string>; action: 'confirm' | 'reject' },
  ) {
    const job = await this.prisma.extractionJob.findFirst({
      where: { id: jobId, tenantId },
      include: { document: { include: { fields: true } } },
    });
    if (!job?.document) throw new NotFoundException('EXTRACTION_JOB_NOT_FOUND');

    if (input.action === 'reject') {
      await this.prisma.extractionJob.update({
        where: { id: jobId },
        data: { status: 'REJECTED' },
      });
      return this.detail(tenantId, jobId);
    }

    // 仅接受该 docType 预置字段白名单，防外部键注入
    const allowed = new Map(FIELD_SPECS[job.document.docType as DocType].map((s) => [s.key, s]));
    const writes: Prisma.PrismaPromise<unknown>[] = [];

    for (const [key, rawValue] of Object.entries(input.fields)) {
      const spec = allowed.get(key);
      if (!spec) continue;
      const value = rawValue.trim().slice(0, 2000);
      const existing = job.document.fields.find((f) => f.key === key);
      if (existing) {
        writes.push(
          this.prisma.extractedField.update({
            where: { id: existing.id },
            data: { value, confidence: 100 },
          }),
        );
      } else if (value) {
        writes.push(
          this.prisma.extractedField.create({
            data: { documentId: job.document.id, key, label: spec.label, value, required: spec.required, confidence: 100 },
          }),
        );
      }
    }

    await this.prisma.$transaction([
      ...writes,
      this.prisma.extractionDeficiency.updateMany({
        where: { jobId, resolved: false },
        data: { resolved: true },
      }),
      this.prisma.extractedDocument.update({ where: { id: job.document.id }, data: { confirmed: true } }),
      this.prisma.extractionJob.update({ where: { id: jobId }, data: { status: 'CONFIRMED' } }),
      this.prisma.reviewConfirmation.upsert({
        where: { jobId },
        update: { payload: input.fields as Prisma.InputJsonValue, userId },
        create: { jobId, userId, payload: input.fields as Prisma.InputJsonValue },
      }),
    ]);

    // 产品文档人工确认入库 -> 同步产品中心（失败降级，不影响确认结果）
    if (job.document.docType === 'product') {
      try {
        const merged: Record<string, string> = {};
        for (const f of job.document.fields) merged[f.key] = f.value;
        for (const [k, v] of Object.entries(input.fields)) merged[k] = v.trim();
        await syncProductFromDocument(this.prisma, tenantId, merged as ProductDocFields, job.document.content);
      } catch (e) {
        this.logger.warn(`产品同步失败（已降级）: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return this.detail(tenantId, jobId);
  }

  /** 删除已入库文档（连带提取任务级联删除） */
  async removeDocument(tenantId: string, documentId: string): Promise<void> {
    const doc = await this.prisma.extractedDocument.findFirst({ where: { id: documentId, tenantId } });
    if (!doc) throw new NotFoundException('DOCUMENT_NOT_FOUND');
    await this.prisma.extractionJob.delete({ where: { id: doc.jobId } });
  }
}
