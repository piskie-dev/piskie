/**
 * Layout 主布局：天际栏、双轨导航和内容区。
 * 顶部为与模块解耦的全局系统栏(全路由同一条,不显示模块标题);
 * 模块身份与切换由导航坞/棱镜承担。
 */

import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useIncidentStore, useUIStore } from '../../store';
import { useAgentControl } from '../../renderer-runtime/hooks';
import { selectVisibleIncidents } from '../../features/incidents';
import { SkyBar } from '../../features/skybar';
import { EdgeDock } from '../../features/navhub/EdgeDock';
import { PrismHub } from '../../features/navhub/PrismHub';
import { NAV_STOPS, type NavStop } from '../../features/navhub/nav-stops';

interface MainLayoutProps {
  children: React.ReactNode;
}

const MainLayout: React.FC<MainLayoutProps> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const consoleTaskStatus = useAgentControl((snapshot) => snapshot.header.status);
  const visibleIncidentCount = useIncidentStore(
    (state) => selectVisibleIncidents(state.incidents).length,
  );
  const currentPath = location.pathname || '/dashboard';
  const isConsoleRoute = location.pathname === '/console' || location.pathname === '/';

  /* 两种导航形态共用目的地事实表与运行状态求值。 */
  const navEdgeDockEnabled = useUIStore((state) => state.navEdgeDockEnabled);
  const navPrismEnabled = useUIStore((state) => state.navPrismEnabled);
  const navPrismSpot = useUIStore((state) => state.navPrismSpot);
  const updateSettings = useUIStore((state) => state.updateSettings);
  const navActivePath = currentPath === '/' ? '/console' : currentPath;
  const navStops: NavStop[] = NAV_STOPS.map((spec) => ({
    path: spec.path,
    title: t(spec.titleKey),
    Icon: spec.Icon,
    live: spec.path === '/console' && consoleTaskStatus === 'running',
  }));

  return (
    <div className="flex flex-col h-screen w-screen bg-cyber-bg overflow-hidden">
      {/* 全局系统栏；macOS 窗口控制按钮与栏同层。 */}
      <SkyBar />

      {/* 内容区全幅展示，不再为常驻左侧导航预留空间。 */}
      <div className={`flex flex-1 min-h-0 ${isConsoleRoute ? '' : 'px-4'}`}>
        <main className="flex-1 overflow-auto bg-cyber-bg cyber-scrollbar">
          {children}
        </main>
      </div>

      {/* 两种浮层导航均可配置，但至少保留一种。 */}
      {navEdgeDockEnabled && (
        <EdgeDock stops={navStops} activePath={navActivePath} onGo={(path) => navigate(path)} />
      )}
      {navPrismEnabled && (
        <PrismHub
          stops={navStops}
          activePath={navActivePath}
          onGo={(path) => navigate(path)}
          tone={visibleIncidentCount > 0 ? 'halt' : 'calm'}
          spot={navPrismSpot}
          onSpot={(spot) => { void updateSettings({ navPrismSpot: spot }); }}
        />
      )}
    </div>
  );
};

export default MainLayout;
