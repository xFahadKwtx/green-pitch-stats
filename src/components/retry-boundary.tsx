import { Component, type ReactNode } from "react";

/** Sanitized boundary: never renders the error object; retry resets Query, then the boundary. */
export class RetryBoundary extends Component<
  { children: ReactNode; onReset: () => void; fallback: (retry: () => void) => ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  retry = () => {
    this.props.onReset();
    this.setState({ failed: false });
  };
  override render() {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children;
  }
}
