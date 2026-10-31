import express from "express";
import "dotenv/config";
import { MongoClient } from "mongodb";
const app = express();
const PORT = process.env.PORT || 7000;

const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

connectToMongoDB();

app.get("/", (req, res) => {
  res.send("hello world");
});

app.listen(PORT, () => {
  console.log(`example app listing on port ${PORT}`);
});
