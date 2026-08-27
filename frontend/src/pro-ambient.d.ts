// Optional commercial overlay modules. OSS builds resolve these aliases to
// local no-op stubs at Vite runtime; ambient declarations keep strict tsc
// usable without the private overlay source tree.
declare module '@pro/data/proExamples' {
  export const proExamples: any[];
}
declare module '@pro/pages/marketing' {
  export const MARKETING_ROUTE_COMPONENTS: Record<string, import('react').FC>;
}
declare module '@pro/i18n/register' {
  export function registerProI18n(): void;
}
declare module '@pro/index' {
  export function mountPro(): void;
}
declare module '@pro/desktop_index' {
  export function mountProDesktop(): void;
}
