// supabaseClient.ts
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!; 
// Use SERVICE_ROLE key on backend (secure) rather than anon key.

export const supabase = createClient(supabaseUrl, supabaseKey);
