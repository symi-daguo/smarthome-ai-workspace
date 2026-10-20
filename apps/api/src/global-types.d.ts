// 全局类型引用锚点（不产出运行时代码，仅让 tsc 看到这些全局增强）。
//
// 背景：升级 TypeScript 6.0.3 后，控制器里 `Express.Multer.File` 这类写法全部报
// TS2694「Namespace 'global.Express' has no exported member 'Multer'」。
// 原因是 TS 6 收紧了 `@types` 包的全局命名空间增强——不再无条件并入编译单元，
// 必须有显式引用，`@types/multer` 对 `Express.Multer` 的声明合并才会生效。
//
// 为什么停在 6.0.3 而不是最新的 7.0.2：
// 7.0 是 Go 重写版且官方声明「没有稳定的编程式 API」，内嵌 TS 的工具链要等 7.1；
// 而 @nestjs/swagger@12.0.2 的 peerDependencies 明确写着 `typescript: ^5.5.0 || ^6.0.0`，
// 装 7.0.2 会直接 unmet peer。6.0.3 是当前工具链能接受的最新稳定版，也是官方建议的过渡跳板。

/// <reference types="node" />
/// <reference types="express" />
/// <reference types="multer" />

export {};
