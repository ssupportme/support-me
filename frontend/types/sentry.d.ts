declare module '@sentry/nextjs' {
  export const init: any;
  export const captureException: any;
  export const withSentryConfig: any;
  export const replayIntegration: any;
  export const feedbackIntegration: any;
  export const captureRequestError: any;
  export const captureRouterTransitionStart: any;
}
