// user.service.interface.ts
export abstract class ConnectorInterface {
    abstract dataToPrompt(): Promise<string>;
  
    abstract syncData(): void;

    abstract oauthConnect(): Promise<boolean>

    async saveCredentials(): Promise<boolean> {
      return true;
    };
  }