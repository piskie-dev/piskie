import { useEffect, useLayoutEffect, useState } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { ConsolePage } from './features/console';
import Market from './pages/Market';
import { ImDossierPage } from './features/imdossier/ImDossierPage';
import { PrefDeckPage } from './features/prefdeck/PrefDeckPage';
import EnvStudio from './features/envstudio/EnvStudio';
import MainLayout from './components/Layout';
import {
  AgentLifecycleToastBridge,
  IncidentToastBridge,
} from './features/incidents';
import { ToastHost } from './features/toasts';
import AppBackground from './components/shared/AppBackground';
import { ContentLinkHost } from './components/content-links';
import { useUIStore } from './store';

function WorkspaceShell() {
  return (
    <MainLayout>
      <Routes>
        <Route path="/console" element={<ConsolePage />} />
        <Route path="/market" element={<Market />} />
        <Route path="/skills" element={<Navigate to="/market?view=installed" replace />} />
        {/* IM 渠道页；保留 /connections 重定向以兼容旧书签。 */}
        <Route path="/messaging" element={<ImDossierPage />} />
        <Route path="/connections" element={<Navigate to="/messaging" replace />} />
        <Route path="/browser" element={<EnvStudio />} />
        {/* 对比期的临时入口已收编；老书签仍可用 */}
        <Route path="/browser-studio" element={<Navigate to="/browser" replace />} />
        {/* 设置页；旧 /settings 连同查询参数重定向到新路由。 */}
        <Route path="/settings" element={<LegacySettingsRedirect />} />
        <Route path="/preferences" element={<PrefDeckPage />} />
        <Route path="/" element={<Navigate to="/console" replace />} />
        <Route path="*" element={<Navigate to="/console" replace />} />
      </Routes>
    </MainLayout>
  );
}

/** 老 /settings 书签跳新设置台,保留查询串(?tab= 由 PrefDeckPage 桥接成 ?sect=) */
function LegacySettingsRedirect() {
  const location = useLocation();
  return <Navigate to={{ pathname: '/preferences', search: location.search }} replace />;
}

function App() {
  const { theme: themeMode } = useUIStore();

  // 按 themeMode、系统偏好和壁纸明暗共同解析实际主题。
  // auto = 无壁纸跟系统（matchMedia）、有壁纸跟壁纸明暗（backgroundIsLight，
  // 未判定按深色兜底）；主题单一来源:<html data-theme> 驱动 tokens.css 变量块
  // (2026-08-25 antd 清零后,ConfigProvider/antd-theme 主题桥随之退役)。
  const backgroundImage = useUIStore(s => s.backgroundImage);
  const backgroundIsLight = useUIStore(s => s.backgroundIsLight);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const autoDark = backgroundImage ? !(backgroundIsLight ?? false) : systemDark;
  const isDark = themeMode === 'dark' || (themeMode === 'auto' && autoDark);
  const colorScheme = isDark ? 'dark' : 'light';
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-theme', colorScheme);
    void window.piskie.desktop.theme.setColorScheme(colorScheme).catch((error) => {
      console.error('Failed to synchronize the desktop color scheme:', error);
    });
  }, [colorScheme]);

  return (
    <ContentLinkHost>
      <AppBackground />
      <IncidentToastBridge />
      <AgentLifecycleToastBridge />
      <ToastHost />
      <WorkspaceShell />
    </ContentLinkHost>
  );
}

export default App;
