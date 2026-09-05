"use client";

import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** Keep an unexpected report rendering error inside its own tab. */
export class ReportErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return <div role="alert" className="space-y-3 rounded border border-destructive bg-card p-4 text-sm"><p className="font-medium">このレポートの表示でエラーが発生しました。</p><p>他のタブやサポート操作は引き続き利用できます。</p><pre className="whitespace-pre-wrap break-all rounded bg-muted p-3">{this.state.error.message}</pre><Button variant="outline" onClick={() => this.setState({ error: null })}>表示を再試行</Button></div>;
  }
}
