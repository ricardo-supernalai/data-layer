import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SupabaseModule } from './supabase/supabase.module';
import { GmailConnectorModule } from './connectors/gmail.connector/gmail.connector.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SupabaseModule,
    GmailConnectorModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
