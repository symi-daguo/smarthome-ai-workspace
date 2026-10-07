import { App as AntdApp } from 'antd';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './store/AuthContext';
import { ChatStoreProvider } from './store/ChatStore';
import { ThemeProvider } from './theme/ThemeProvider';
import { MainLayout } from './layouts/MainLayout';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { TokenCenter } from './pages/TokenCenter';
import { ModelTest } from './pages/ModelTest';
import { ContentExtract } from './pages/ContentExtract';
import { AgentMarket } from './pages/AgentMarket';
import { ImageStudio } from './pages/ImageStudio';
import { VideoStudio } from './pages/VideoStudio';
import { PlanStudio } from './pages/PlanStudio';
import { TreasureBox } from './pages/TreasureBox';
import { DeviceLayout } from './pages/DeviceLayout';
import { QuoteStudio } from './pages/QuoteStudio';
import { KnowledgeBase } from './pages/KnowledgeBase';
import { MyAssets } from './pages/MyAssets';
import { OrderStudio } from './pages/OrderStudio';
import { BiographyStudio } from './pages/BiographyStudio';
import { MaterialLibrary } from './pages/MaterialLibrary';
import { PlanShareView } from './pages/PlanShareView';

function ProtectedRoutes(): React.ReactNode {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return (
    <ChatStoreProvider>
      <Routes>
        <Route element={<MainLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="agents" element={<AgentMarket />} />
          <Route path="image" element={<ImageStudio />} />
          <Route path="video" element={<VideoStudio />} />
          <Route path="plan" element={<PlanStudio />} />
          <Route path="order" element={<OrderStudio />} />
          <Route path="biography" element={<BiographyStudio />} />
          <Route path="materials" element={<MaterialLibrary />} />
          <Route path="treasure" element={<TreasureBox />} />
          <Route path="device-layout" element={<DeviceLayout />} />
          <Route path="quote" element={<QuoteStudio />} />
          <Route path="knowledge" element={<KnowledgeBase />} />
          <Route path="works" element={<MyAssets />} />
          <Route path="content" element={<ContentExtract />} />
          <Route path="tokens" element={<TokenCenter />} />
          <Route path="model-test" element={<ModelTest />} />
        </Route>
      </Routes>
    </ChatStoreProvider>
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
              <Route path="*" element={<ProtectedRoutes />} />
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </AntdApp>
    </ThemeProvider>
  );
}
