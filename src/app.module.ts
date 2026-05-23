import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GmailConnectorModule } from './connectors/gmail.connector/gmail.connector.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    GmailConnectorModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
