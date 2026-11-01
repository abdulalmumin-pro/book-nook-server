import express from "express";
import "dotenv/config";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
const app = express();
const PORT = process.env.PORT || 7000;

app.use(cors())
app.use(express.json())

const verifyApi = (req, res, next) =>{
  const authHeader = req.headers.authorization
  console.log(authHeader)
  if(authHeader !== "user logged in"){
    return res.status(401).send({messege: 'Unauthorized'})

  }
  next()
  console.log('i am middleware');

}

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

const MongodbClient = await connectToMongoDB();

const db = MongodbClient.db('book-nook');
const booksCollection = db.collection('books');

app.post('/add-books', async(req, res) => {
    const data = req.body;
    const result = await booksCollection.insertOne(data);
    console.log(result);
    res.send(result)
})

app.get("/books", async(req, res) => {
    const result = await booksCollection.find().toArray();
    res.send(result)
})

app.get('/books/:id', verifyApi,  async(req, res) => {
  
  const {id} = req.params;
  const result = await booksCollection.findOne({_id: new ObjectId(id)})

  res.send(result);
})

app.get("/", (req, res) => {
  res.send("hello world");
});


app.listen(PORT, () => {
  console.log(`example app listing on port ${PORT}`);
});
