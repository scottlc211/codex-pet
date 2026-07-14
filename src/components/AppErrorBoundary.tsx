import { Component, type ErrorInfo, type ReactNode } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { recordDiagnosticEvent } from "../runtime/diagnostics";

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  failed: boolean;
};

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Codex Pet render failed", error, info.componentStack);
    recordDiagnosticEvent(
      "error",
      "frontend",
      `render failed: ${error.stack ?? error.message}\n${info.componentStack ?? ""}`,
    );
  }

  render() {
    if (!this.state.failed) {
      return this.props.children;
    }

    return (
      <main className="fatal-error-shell">
        <section className="fatal-error-panel" role="alert">
          <TriangleAlert size={22} />
          <div>
            <h1>界面加载失败</h1>
            <p>重新加载后会保留已保存的设置。</p>
          </div>
          <button type="button" onClick={() => window.location.reload()}>
            <RefreshCw size={16} />
            <span>重新加载</span>
          </button>
        </section>
      </main>
    );
  }
}
