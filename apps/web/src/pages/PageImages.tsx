import { ClearOutlined, PictureOutlined, UploadOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Grid, Popconfirm, Space, Spin, Typography, Upload, theme } from 'antd';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, fileUrl } from '../lib/api';
import { clearPageImage, loadPageImageOverrides, savePageImage, type PageImageMap } from '../lib/pageImages';
import { PAGE_IMAGE, PAGE_TYPE_LABEL, type PlanPage } from '../data/planThemes';

const { Text, Title } = Typography;

/**
 * 页型清单：唯一来源是 `PAGE_IMAGE` 的键（= `PlanPage['type']`）。
 *
 * 为什么从常量派生而不是手写一份数组：
 * 手写一份必然与 PAGE_IMAGE 漂移 —— 前端加了页型、配图页却列不出来，
 * 门店就永远没机会给新页型配图。这里直接取键，新增页型自动出现在这页。
 */
const PAGE_TYPES = Object.keys(PAGE_IMAGE) as PlanPage['type'][];

/**
 * 方案页型配图管理。
 *
 * 解决的问题：PPT 方案里每一页的配图此前是**按页型写死的本地图片**
 * （`/images/cases/c1.jpg` 那几张通用实景图），门店换不了自己的案例图。
 * 这里让门店为每个页型上传自己的图，导出 PPTX 时自动用上。
 *
 * 配图是**租户级**的：每家门店各配各的，互不影响。
 */
export function PageImages(): ReactNode {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  /** 本租户已配置的页型配图 */
  const [map, setMap] = useState<PageImageMap>({});
  const [loading, setLoading] = useState(true);
  /** 正在上传/保存/清除的页型（null = 无操作进行中） */
  const [busy, setBusy] = useState<PlanPage['type'] | null>(null);

  /**
   * 重新读取并同步到运行时覆盖表。
   *
   * 读回来就顺手刷新覆盖表（loadPageImageOverrides 内部做），
   * 这样在本页改完配图后，当前标签页里已打开的方案预览立刻就是新图。
   */
  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setMap(await loadPageImageOverrides());
    } catch (e) {
      message.error((e as Error).message || '读取页型配图失败');
      setMap({});
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 上传新图 → 立刻保存到该页型 */
  const upload = async (pageType: PlanPage['type'], file: File): Promise<void> => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      message.warning('仅支持 JPG / PNG / WebP 图片');
      return;
    }
    setBusy(pageType);
    try {
      // 复用既有的素材上传端点（落 uploads 卷 + 写 MediaAsset），
      // 不新造上传通道 —— 素材统一进「我的作品」，配额与清理工具都认得它。
      const fd = new FormData();
      fd.append('file', file);
      fd.append('title', `${PAGE_TYPE_LABEL[pageType]}配图`);
      const up = await api<{ id: string; url: string }>('/api/media/uploads', { method: 'POST', body: fd });
      await savePageImage(pageType, up.id);
      await reload();
      message.success(`「${PAGE_TYPE_LABEL[pageType]}」配图已更新`);
    } catch (e) {
      message.error((e as Error).message || '配图保存失败');
    } finally {
      setBusy(null);
    }
  };

  /** 清除该页型的配图（回到写死的兜底实景图） */
  const clear = async (pageType: PlanPage['type']): Promise<void> => {
    setBusy(pageType);
    try {
      await clearPageImage(pageType);
      await reload();
      message.success(`「${PAGE_TYPE_LABEL[pageType]}」已恢复默认图`);
    } catch (e) {
      message.error((e as Error).message || '清除失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ width: '100%', paddingBottom: 24 }}>
      <div style={{ marginBottom: 4 }}>
        <Title level={3} style={{ marginBottom: 4 }}>页型配图</Title>
        <Text type="secondary">
          给 PPT 方案的每个页型配自己的实景图。没配置的页型仍用系统默认图 —— 导出行为与以前完全一致。
        </Text>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '64px 0' }}>
          <Spin />
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(auto-fill, minmax(${screens.md ? 360 : 300}px, 1fr))`,
            gap: 14,
            marginTop: 18,
          }}
        >
          {PAGE_TYPES.map((pageType) => {
            const configured = map[pageType];
            const defaultSrc = PAGE_IMAGE[pageType];
            const currentSrc = configured ? fileUrl(configured.url) : defaultSrc;
            const working = busy === pageType;
            return (
              <div
                key={pageType}
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'center',
                  padding: 12,
                  borderRadius: 10,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  background: token.colorBgContainer,
                }}
              >
                <img
                  src={currentSrc}
                  alt={PAGE_TYPE_LABEL[pageType]}
                  style={{
                    width: 96,
                    height: 64,
                    objectFit: 'cover',
                    borderRadius: 6,
                    background: token.colorFillQuaternary,
                    flex: '0 0 auto',
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Text strong>{PAGE_TYPE_LABEL[pageType]}</Text>
                    {configured ? (
                      <Text style={{ fontSize: 12, color: token.colorSuccess }}>已自定义</Text>
                    ) : (
                      <Text style={{ fontSize: 12, color: token.colorTextTertiary }}>默认图</Text>
                    )}
                  </div>
                  <Text
                    type="secondary"
                    style={{ fontSize: 12, display: 'block', marginBottom: 8 }}
                    ellipsis
                    title={configured ? configured.mediaAssetId : defaultSrc}
                  >
                    {configured ? '门店自定义图片' : `默认实景图 ${defaultSrc}`}
                  </Text>
                  <Space size={6} wrap>
                    <Upload
                      accept="image/jpeg,image/png,image/webp"
                      showUploadList={false}
                      beforeUpload={(file) => {
                        void upload(pageType, file as unknown as File);
                        return false;
                      }}
                    >
                      <Button size="small" icon={<UploadOutlined />} loading={working}>
                        {configured ? '更换' : '上传'}
                      </Button>
                    </Upload>
                    <Popconfirm
                      title="清除该页型的自定义配图？"
                      description="清除后这一页恢复使用系统默认实景图。"
                      okText="清除"
                      cancelText="取消"
                      onConfirm={() => void clear(pageType)}
                      disabled={!configured}
                    >
                      <Button size="small" icon={<ClearOutlined />} disabled={!configured || working}>
                        清除
                      </Button>
                    </Popconfirm>
                  </Space>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          <PictureOutlined style={{ marginRight: 6 }} />
          配图是本门店（租户）自己的设置，换一家门店互不影响。图片上传后进入「我的作品」，可在那里清理。
        </Text>
      </div>
    </div>
  );
}
