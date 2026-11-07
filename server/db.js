import { MongoClient } from "mongodb";

let client = null;
let connecting = null;

function dbName() {
  return process.env.MONGODB_DB || "HackRPI";
}

function collectionName() {
  return process.env.MONGODB_COLLECTION || "hackrpi";
}

export async function getCollection() {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  try {
    if (!client) {
      if (!connecting) {
        connecting = MongoClient.connect(uri, { serverSelectionTimeoutMS: 2000 })
          .then((next) => {
            client = next;
            return next;
          })
          .catch(() => {
            connecting = null;
            console.error("Leaderboard database unavailable");
            return null;
          });
      }
      const connected = await connecting;
      if (!connected) return null;
    }
    const database = client.db(dbName());
    const scores = database.collection(collectionName());
    if (!scores.__boardIndex) {
      await scores.createIndex({ distance: -1, createdAt: 1 });
      scores.__boardIndex = true;
    }
    return scores;
  } catch {
    console.error("Leaderboard database unavailable");
    return null;
  }
}

export async function ping() {
  if (!process.env.MONGODB_URI) return false;
  try {
    const scores = await getCollection();
    if (!scores || !client) return false;
    await client.db(dbName()).command({ ping: 1 });
    return true;
  } catch {
    console.error("Leaderboard database unavailable");
    return false;
  }
}
