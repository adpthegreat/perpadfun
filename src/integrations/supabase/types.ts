export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      keeper_actions: {
        Row: {
          action_kind: string
          amount_sol: number | null
          amount_tokens: number | null
          amount_usd: number | null
          confirmed_at: string | null
          created_at: string
          error: string | null
          external_id: string | null
          id: string
          intent_hash: string
          request_payload: Json
          response_payload: Json
          signature: string | null
          status: string
          token_id: string
          updated_at: string
        }
        Insert: {
          action_kind: string
          amount_sol?: number | null
          amount_tokens?: number | null
          amount_usd?: number | null
          confirmed_at?: string | null
          created_at?: string
          error?: string | null
          external_id?: string | null
          id?: string
          intent_hash: string
          request_payload?: Json
          response_payload?: Json
          signature?: string | null
          status?: string
          token_id: string
          updated_at?: string
        }
        Update: {
          action_kind?: string
          amount_sol?: number | null
          amount_tokens?: number | null
          amount_usd?: number | null
          confirmed_at?: string | null
          created_at?: string
          error?: string | null
          external_id?: string | null
          id?: string
          intent_hash?: string
          request_payload?: Json
          response_payload?: Json
          signature?: string | null
          status?: string
          token_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "keeper_actions_token_id_fkey"
            columns: ["token_id"]
            isOneToOne: false
            referencedRelation: "tokens"
            referencedColumns: ["id"]
          },
        ]
      }
      keeper_logs: {
        Row: {
          created_at: string
          event: string | null
          fields: Json
          id: number
          level: string
          message: string
          tick_id: string | null
          token_id: string | null
        }
        Insert: {
          created_at?: string
          event?: string | null
          fields?: Json
          id?: number
          level?: string
          message: string
          tick_id?: string | null
          token_id?: string | null
        }
        Update: {
          created_at?: string
          event?: string | null
          fields?: Json
          id?: number
          level?: string
          message?: string
          tick_id?: string | null
          token_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "keeper_logs_token_id_fkey"
            columns: ["token_id"]
            isOneToOne: false
            referencedRelation: "tokens"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          evm_address: string | null
          id: string
          solana_address: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          evm_address?: string | null
          id?: string
          solana_address?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          display_name?: string | null
          evm_address?: string | null
          id?: string
          solana_address?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      token_workflows: {
        Row: {
          attempt_count: number
          blocked_reason: string | null
          buyback_reserved_usd: number
          created_at: string
          imperial_deposited_usd: number
          last_observed_at: string | null
          last_observed_imperial_usdc: number | null
          last_observed_sub_sol: number | null
          last_observed_sub_usdc: number | null
          last_successful_step: string | null
          locked_at: string | null
          locked_by: string | null
          metadata: Json
          next_retry_at: string | null
          perp_reserved_usd: number
          position_collateral_usd: number
          position_entry_price: number | null
          position_entry_source: string | null
          position_size_usd: number
          state: string
          token_id: string
          treasury_reserved_usd: number
          updated_at: string
        }
        Insert: {
          attempt_count?: number
          blocked_reason?: string | null
          buyback_reserved_usd?: number
          created_at?: string
          imperial_deposited_usd?: number
          last_observed_at?: string | null
          last_observed_imperial_usdc?: number | null
          last_observed_sub_sol?: number | null
          last_observed_sub_usdc?: number | null
          last_successful_step?: string | null
          locked_at?: string | null
          locked_by?: string | null
          metadata?: Json
          next_retry_at?: string | null
          perp_reserved_usd?: number
          position_collateral_usd?: number
          position_entry_price?: number | null
          position_entry_source?: string | null
          position_size_usd?: number
          state?: string
          token_id: string
          treasury_reserved_usd?: number
          updated_at?: string
        }
        Update: {
          attempt_count?: number
          blocked_reason?: string | null
          buyback_reserved_usd?: number
          created_at?: string
          imperial_deposited_usd?: number
          last_observed_at?: string | null
          last_observed_imperial_usdc?: number | null
          last_observed_sub_sol?: number | null
          last_observed_sub_usdc?: number | null
          last_successful_step?: string | null
          locked_at?: string | null
          locked_by?: string | null
          metadata?: Json
          next_retry_at?: string | null
          perp_reserved_usd?: number
          position_collateral_usd?: number
          position_entry_price?: number | null
          position_entry_source?: string | null
          position_size_usd?: number
          state?: string
          token_id?: string
          treasury_reserved_usd?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "token_workflows_token_id_fkey"
            columns: ["token_id"]
            isOneToOne: true
            referencedRelation: "tokens"
            referencedColumns: ["id"]
          },
        ]
      }
      tokens: {
        Row: {
          buyback_reserve_usd: number
          claim_token: string | null
          created_at: string
          creator_address: string | null
          creator_id: string | null
          current_price_sol: number | null
          curve_preset: string
          dbc_config_address: string | null
          dbc_pool_address: string | null
          description: string | null
          direction: string
          external_mint: string | null
          external_platform: string | null
          fees_accrued_usd: number
          first_fee_routed_at: string | null
          graduated_pool_address: string | null
          id: string
          image_url: string | null
          imperial_profile_index: number
          imperial_profile_pda: string | null
          last_fee_claim_at: string | null
          last_fee_claim_signature: string | null
          last_sol_raised_seen: number
          last_tick_at: string | null
          last_tick_mid: number | null
          launch_mid: number | null
          launch_signature: string | null
          leverage: number
          lp_position_address: string | null
          metadata_address: string | null
          migration_status: string
          mint_address: string | null
          mint_pending: boolean
          name: string
          opened_collateral_usd: number
          pending_drift_sig: string | null
          pnl_high_water_usd: number
          pool_state_refreshed_at: string | null
          position_collateral_usd: number
          position_opened_at: string | null
          position_size_usd: number
          quote_token: string
          router: string
          sol_raised: number
          source: string
          status: string
          ticker: string
          tokens_burned: number
          total_supply: number | null
          treasury_pnl_usd: number
          treasury_sol: number
          treasury_wallet_address: string
          twitter_url: string | null
          underlying: string
          website_url: string | null
        }
        Insert: {
          buyback_reserve_usd?: number
          claim_token?: string | null
          created_at?: string
          creator_address?: string | null
          creator_id?: string | null
          current_price_sol?: number | null
          curve_preset?: string
          dbc_config_address?: string | null
          dbc_pool_address?: string | null
          description?: string | null
          direction: string
          external_mint?: string | null
          external_platform?: string | null
          fees_accrued_usd?: number
          first_fee_routed_at?: string | null
          graduated_pool_address?: string | null
          id?: string
          image_url?: string | null
          imperial_profile_index?: number
          imperial_profile_pda?: string | null
          last_fee_claim_at?: string | null
          last_fee_claim_signature?: string | null
          last_sol_raised_seen?: number
          last_tick_at?: string | null
          last_tick_mid?: number | null
          launch_mid?: number | null
          launch_signature?: string | null
          leverage: number
          lp_position_address?: string | null
          metadata_address?: string | null
          migration_status?: string
          mint_address?: string | null
          mint_pending?: boolean
          name: string
          opened_collateral_usd?: number
          pending_drift_sig?: string | null
          pnl_high_water_usd?: number
          pool_state_refreshed_at?: string | null
          position_collateral_usd?: number
          position_opened_at?: string | null
          position_size_usd?: number
          quote_token?: string
          router?: string
          sol_raised?: number
          source?: string
          status?: string
          ticker: string
          tokens_burned?: number
          total_supply?: number | null
          treasury_pnl_usd?: number
          treasury_sol?: number
          treasury_wallet_address: string
          twitter_url?: string | null
          underlying: string
          website_url?: string | null
        }
        Update: {
          buyback_reserve_usd?: number
          claim_token?: string | null
          created_at?: string
          creator_address?: string | null
          creator_id?: string | null
          current_price_sol?: number | null
          curve_preset?: string
          dbc_config_address?: string | null
          dbc_pool_address?: string | null
          description?: string | null
          direction?: string
          external_mint?: string | null
          external_platform?: string | null
          fees_accrued_usd?: number
          first_fee_routed_at?: string | null
          graduated_pool_address?: string | null
          id?: string
          image_url?: string | null
          imperial_profile_index?: number
          imperial_profile_pda?: string | null
          last_fee_claim_at?: string | null
          last_fee_claim_signature?: string | null
          last_sol_raised_seen?: number
          last_tick_at?: string | null
          last_tick_mid?: number | null
          launch_mid?: number | null
          launch_signature?: string | null
          leverage?: number
          lp_position_address?: string | null
          metadata_address?: string | null
          migration_status?: string
          mint_address?: string | null
          mint_pending?: boolean
          name?: string
          opened_collateral_usd?: number
          pending_drift_sig?: string | null
          pnl_high_water_usd?: number
          pool_state_refreshed_at?: string | null
          position_collateral_usd?: number
          position_opened_at?: string | null
          position_size_usd?: number
          quote_token?: string
          router?: string
          sol_raised?: number
          source?: string
          status?: string
          ticker?: string
          tokens_burned?: number
          total_supply?: number | null
          treasury_pnl_usd?: number
          treasury_sol?: number
          treasury_wallet_address?: string
          twitter_url?: string | null
          underlying?: string
          website_url?: string | null
        }
        Relationships: []
      }
      treasury_events: {
        Row: {
          created_at: string
          id: string
          kind: string
          mid: number | null
          note: string | null
          pnl_delta_usd: number | null
          sol_amount: number | null
          token_id: string
          tokens_amount: number | null
          tx_sig: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          mid?: number | null
          note?: string | null
          pnl_delta_usd?: number | null
          sol_amount?: number | null
          token_id: string
          tokens_amount?: number | null
          tx_sig?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          mid?: number | null
          note?: string | null
          pnl_delta_usd?: number | null
          sol_amount?: number | null
          token_id?: string
          tokens_amount?: number | null
          tx_sig?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "treasury_events_token_id_fkey"
            columns: ["token_id"]
            isOneToOne: false
            referencedRelation: "tokens"
            referencedColumns: ["id"]
          },
        ]
      }
      tx_log: {
        Row: {
          amount_sol: number | null
          amount_tokens: number | null
          amount_usd: number | null
          confirmed_at: string | null
          created_at: string
          error: string | null
          id: string
          intent_hash: string
          kind: string
          signature: string | null
          status: string
          token_id: string
        }
        Insert: {
          amount_sol?: number | null
          amount_tokens?: number | null
          amount_usd?: number | null
          confirmed_at?: string | null
          created_at?: string
          error?: string | null
          id?: string
          intent_hash: string
          kind: string
          signature?: string | null
          status?: string
          token_id: string
        }
        Update: {
          amount_sol?: number | null
          amount_tokens?: number | null
          amount_usd?: number | null
          confirmed_at?: string | null
          created_at?: string
          error?: string | null
          id?: string
          intent_hash?: string
          kind?: string
          signature?: string | null
          status?: string
          token_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

