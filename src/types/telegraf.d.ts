import 'telegraf';

declare module 'telegraf' {
  interface Context {
    session?: {
      acceptedTerms?: boolean;
      [key: string]: any;
    };
  }
}



