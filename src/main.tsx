import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { RendererStartupError } from './components/RendererStartupError';
import { createRendererRuntime } from './renderer-runtime/createRendererRuntime';
import { RendererRuntimeProvider } from './renderer-runtime/RendererRuntimeProvider';
import type { RendererRuntime } from './renderer-runtime/renderer-runtime';
import { useUIStore } from './store/uiStore';
import './i18n'; // 初始化 i18n
import './styles/global.css';

const RUNTIME_KEY = '__piskieRendererRuntime';

void mountRenderer();

async function mountRenderer(): Promise<void> {
  const host = window as typeof window & { [RUNTIME_KEY]?: RendererRuntime };
  await host[RUNTIME_KEY]?.stop();

  const runtime = createRendererRuntime(window.piskie);
  host[RUNTIME_KEY] = runtime;
  const root = ReactDOM.createRoot(document.getElementById('root')!);

  try {
    await runtime.start();
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <RendererRuntimeProvider runtime={runtime}>
            <HashRouter>
              <App />
            </HashRouter>
          </RendererRuntimeProvider>
        </ErrorBoundary>
      </React.StrictMode>,
    );
  } catch (error) {
    root.render(
      <RendererStartupError
        error={error}
        language={useUIStore.getState().settings?.language}
      />,
    );
  }

  const stop = () => {
    void runtime.stop();
  };
  window.addEventListener('beforeunload', stop, { once: true });
  import.meta.hot?.dispose(() => {
    window.removeEventListener('beforeunload', stop);
    void runtime.stop();
  });
}
