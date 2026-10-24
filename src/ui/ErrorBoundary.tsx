import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { failed: boolean; message: string };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, message: '' };

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error(error, info);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="h-full grid place-items-center p-6 bg-bg text-ink">
        <section className="w-full max-w-md bg-card border border-line rounded-xl2 p-5 text-center">
          <div className="w-11 h-11 mx-auto mb-3 rounded-xl bg-bad/10 text-bad grid place-items-center text-xl">!</div>
          <h1 className="text-[17px] font-semibold">页面出了点问题</h1>
          <p className="mt-2 text-[12px] leading-relaxed text-mute break-words">{this.state.message || '未知错误'}</p>
          <button type="button" onClick={() => location.reload()} className="mt-5 w-full py-2.5 rounded-xl bg-accent text-white text-[14px] font-semibold">
            重新加载
          </button>
        </section>
      </main>
    );
  }
}
