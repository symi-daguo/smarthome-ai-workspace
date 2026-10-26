import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadBranding } from './lib/branding';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('root element not found');

// 品牌（产品名 + 图标）要在登录前就生效：不 await，失败也不阻塞首屏渲染
void loadBranding();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
