import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const test = async () => {
  try {
    const conn = await mysql.createConnection({
      host: process.env.MYSQL_HOST,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DB,
      port: 3306,
    });
    console.log("✅ Connected successfully!");
    conn.end();
  } catch (err) {
    console.error("❌ Connection failed:", err);
  }
};

test();
