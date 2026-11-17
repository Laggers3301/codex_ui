import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportClientError } from './clientDiagnostics';
import type { ClientErrorScope } from '../shared/clientDiagnostics';
import './renderBoundary.css';

interface Props { children: ReactNode; scope: ClientErrorScope; resetKey?: string; rawText?: string }
/** Keep a bad message/turn out of the application-level error boundary. */
export class RenderBoundary extends Component<Props, { failed: boolean; errorId: string | null }> {
  state = { failed: false, errorId: null as string | null };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    const errorId = reportClientError(error, this.props.scope, info.componentStack ?? '');
    if (errorId) this.setState({ errorId });
  }
  componentDidUpdate(previous: Props) {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false, errorId: null });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    const application = this.props.scope === 'application';
    return <div className={application ? 'appRenderFallback' : 'messageRenderFallback'} role="alert">
      {application ? <h1>界面暂时无法显示</h1> : <p>这部分内容暂时无法显示，其他消息仍可使用。</p>}
      {application ? <p>对话记录未被删除。请重新加载页面；错误诊断会尽可能保存在本机并上传。</p> : null}
      {this.props.rawText ? <pre>{this.props.rawText.slice(0, 48000)}</pre> : null}
      {this.props.rawText && this.props.rawText.length > 48000 ? <p>仅预览前 48,000 字符，原始记录仍然保留。</p> : null}
      <button type="button" onClick={() => application ? window.location.reload() : this.setState({ failed: false, errorId: null })}>
        {application ? '重新加载' : '重试显示'}
      </button>
      {this.state.errorId ? <small>错误编号：{this.state.errorId}</small> : null}
    </div>;
  }
}
