export interface BrowserGuestRequest {
  token: string;
  pageId: string;
  viewId: string;
  partition: string;
  width: number;
  height: number;
}

export interface BrowserGuestPresentation {
  token: string;
  revision: number;
  bounds: { x: number; y: number; width: number; height: number };
  visible: boolean;
  focus?: boolean;
}

export type BrowserHostMessage =
  | { type: "create"; request: BrowserGuestRequest }
  | { type: "present"; presentation: BrowserGuestPresentation }
  | { type: "destroy"; token: string };

export function browserGuestInitialUrl(): string {
  return "about:blank";
}

export function browserGuestBindingAgent(token: string): string {
  return `VironBrowserGuest/${token}`;
}
