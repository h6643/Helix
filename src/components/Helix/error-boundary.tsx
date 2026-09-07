"use client";

import React from "react";

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex flex-col items-center justify-center h-full p-8 text-center">
          <div className="text-[calc(var(--helix-transcript-size)*2.5714)] mb-4">
            !
          </div>
          <h2 className="text-[calc(var(--helix-transcript-size)*1.2857)] font-semibold mb-2">
            出错了
          </h2>
          <p className="text-[length:var(--helix-transcript-size)] text-muted-foreground mb-4">
            {this.state.error?.message || "发生未知错误"}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-[length:var(--helix-transcript-size)] hover:bg-primary/90"
          >
            重试
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
