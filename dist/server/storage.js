"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storage = exports.SupabaseStorage = void 0;
// server/storage.ts
const supabaseClient_1 = require("./supabaseClient");
class SupabaseStorage {
    async getUser(id) {
        const { data, error } = await supabaseClient_1.supabase
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
    async getUserByUsername(username) {
        const { data, error } = await supabaseClient_1.supabase
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
    async createUser(insertUser) {
        const { data, error } = await supabaseClient_1.supabase
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
        return data;
    }
}
exports.SupabaseStorage = SupabaseStorage;
exports.storage = new SupabaseStorage();
