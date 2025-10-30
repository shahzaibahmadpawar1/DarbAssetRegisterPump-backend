// server/storage.ts
import { supabase } from "./supabaseClient";
import type { User, InsertUser as BaseInsertUser } from "../shared/schema";

interface InsertUser extends BaseInsertUser {
  password_hash: string;
  role: string;
}

export interface IStorage {
  getUser(id: string): Promise<User | null>;
  getUserByUsername(username: string): Promise<User | null>;
  createUser(user: InsertUser): Promise<User>;
}

export class SupabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | null> {
    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      console.error("Error fetching user by ID:", error.message);
      return null;
    }

    return data;
  }

  async getUserByUsername(username: string): Promise<User | null> {
    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("username", username)
      .single();

    if (error) {
      console.error("Error fetching user by username:", error.message);
      return null;
    }

    return data;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const { data, error } = await supabase
      .from("users")
      .insert([
        {
          username: insertUser.username,
          password_hash: insertUser.password_hash,
          role: insertUser.role,
        },
      ])
      .select("*")
      .single();

    if (error) {
      console.error("Error creating user:", error.message);
      throw error;
    }

    return data!;
  }
}

export const storage = new SupabaseStorage();
