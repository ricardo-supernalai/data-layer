// user.service.interface.ts
export interface ConnectorInterface {
    dataToPrompt(): Promise<string>;
  
    syncData(): void;
  }