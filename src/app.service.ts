import { Injectable } from '@nestjs/common';
import { SupabaseService } from './supabase/supabase.service';

@Injectable()
export class AppService {
  constructor(private readonly supabase: SupabaseService) {}

  getHello(): string {
    return 'Hello World!';
  }

  async ping(): Promise<{ ok: boolean; user: unknown }> {
    const { data, error } = await this.supabase.getClient().auth.getUser();
    if (error) throw error;
    return { ok: true, user: data.user };
  }
}
