import { App as AntdApp } from 'antd';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './store/AuthContext';
import { ChatStoreProvider } from './store/ChatStore';
import { ConfigProvider } from './lib/configStore';
import { ThemeProvider } from './theme/ThemeProvider';
import { MainLayout } from './layouts/MainLayout';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { TokenCenter } from './pages/TokenCenter';
import { TeamPage } from './pages/TeamPage';
import { ModelConfig } from './pages/ModelConfig';
import { ContentExtract } from './pages/ContentExtract';
import { AgentMarket } from './pages/AgentMarket';
import { ImageStudio } from './pages/ImageStudio';
import { VideoStudio } from './pages/VideoStudio';
import { PlanStudio } from './pages/PlanStudio';
import { PlanPrintView } from './pages/PlanPrintView';
import { TreasureBox } from './pages/TreasureBox';
import { DeviceLayout } from './pages/DeviceLayout';
import { FloorplanStudio } from './pages/FloorplanStudio';
import { LightingStudio } from './pages/LightingStudio';
import { LightingDiagnosis } from './pages/LightingDiagnosis';
import { ImageCanvas } from './pages/ImageCanvas';
import { Feedback } from './pages/Feedback';
import { Quota } from './pages/Quota';
import { QuoteStudio } from './pages/QuoteStudio';
import { ProductCenter } from './pages/ProductCenter';
import { KnowledgeBase } from './pages/KnowledgeBase';
import { MyAssets } from './pages/MyAssets';
import { OrderStudio } from './pages/OrderStudio';
import { BiographyStudio } from './pages/BiographyStudio';
import { Benchmark } from './pages/Benchmark';
import { PlanShareView } from './pages/PlanShareView';

function ProtectedRoutes(): React.ReactNode {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return (
    <ConfigProvider>
      <ChatStoreProvider>
        <Routes>
          <Route element={<MainLayout />}>
            <Route index element={<Dashboard />} />
            <Route path="agents" element={<AgentMarket />} />
            <Route path="image" element={<ImageStudio />} />
            <Route path="canvas" element={<ImageCanvas />} />
            <Route path="video" element={<VideoStudio />} />
            <Route path="plan" element={<PlanStudio />} />
            <Route path="order" element={<OrderStudio />} />
            <Route path="biography" element={<BiographyStudio />} />
            <Route path="benchmark" element={<Benchmark />} />
            {/* 旧「素材库」路由：投稿交易已下线，页面换成对标情报；老书签不该 404 */}
            <Route path="materials" element={<Navigate to="/benchmark" replace />} />
            <Route path="treasure" element={<TreasureBox />} />
            <Route path="device-layout" element={<DeviceLayout />} />
            {/* 平面图与点位：专门板块入口。点位要反复改，改完能被方案与 PPT 拉取 */}
            <Route path="floorplan" element={<FloorplanStudio />} />
            <Route path="lighting" element={<LightingStudio />} />
            <Route path="lighting-diagnosis" element={<LightingDiagnosis />} />
            <Route path="feedback" element={<Feedback />} />
            <Route path="quota" element={<Quota />} />

            <Route path="quote" element={<QuoteStudio />} />
            <Route path="products" element={<ProductCenter />} />
            <Route path="knowledge" element={<KnowledgeBase />} />
            <Route path="works" element={<MyAssets />} />
            <Route path="content" element={<ContentExtract />} />
            <Route path="team" element={<TeamPage />} />
            <Route path="tokens" element={<TokenCenter />} />
            <Route path="model-config" element={<ModelConfig />} />
            {/* 未知路径兜底回首页：没有它的话，旧收藏/手输错字会渲染出整页空白 */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </ChatStoreProvider>
    </ConfigProvider>
  );
}

export function App(): ReactNode {
  return (
    <ThemeProvider>
      {/* antd App 上下文：message/modal/notification 经 App.useApp() 取用，跟随主题且避免静态方法脱离上下文的告警与竞态 */}
      <AntdApp>
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<Login />} />
              {/* 客户分享页无需登录，微信内直接打开 */}
              <Route path="/share/plan/:token" element={<PlanShareView />} />
              {/*
                打印视图（导出高清 PDF）**放在鉴权之外**：
                客户在微信里打开分享页时，要能自己把方案存成 PDF，
                走的是 ?share=<token> 的免鉴权接口。挂在鉴权路由里会被弹回登录页，
                「客户自己导出」这条用法就废了。
                门店自己用 ?id=<planId> 打开同一个页面（需要登录时接口会自行报错提示）。
              */}
              <Route path="/plan-print" element={<PlanPrintView />} />
              <Route path="*" element={<ProtectedRoutes />} />
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </AntdApp>
    </ThemeProvider>
  );
}
