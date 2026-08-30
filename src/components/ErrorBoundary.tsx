import { Component, ErrorInfo, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../store/uiStore';
import { TopLevelErrorView } from './TopLevelErrorView';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

interface ErrorBoundaryImplProps extends Props {
  title: string;
  unknownDetail: string;
  reloadLabel: string;
}

class ErrorBoundaryImpl extends Component<ErrorBoundaryImplProps, State> {
  constructor(props: ErrorBoundaryImplProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <TopLevelErrorView
          title={this.props.title}
          detail={this.state.error?.message || this.props.unknownDetail}
          action={{
            label: this.props.reloadLabel,
            onClick: this.handleReload,
          }}
        />
      );
    }

    return this.props.children;
  }
}

function ErrorBoundary({ children }: Props) {
  const language = useUIStore((state) => state.settings?.language ?? 'en-US');
  const { t } = useTranslation(undefined, { lng: language });

  return (
    <ErrorBoundaryImpl
      title={t('topLevelError.applicationTitle')}
      unknownDetail={t('topLevelError.unknownDetail')}
      reloadLabel={t('topLevelError.reload')}
    >
      {children}
    </ErrorBoundaryImpl>
  );
}

export default ErrorBoundary;
