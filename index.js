import express from "express";
import "dotenv/config";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose";
const app = express();
const PORT = process.env.PORT || 7000;

app.use(cors())
app.use(express.json())

const verifyToken = async(req, res, next) =>{
  const authHeader = req.headers.authorization
  if(!authHeader){
    return res.status(401).send({msg: 'Unauthorized'})
  }
  const token = authHeader.split(" ")[1]
  if(!token){
    return res.status(401).send({msg: 'Unauthorized'})
  }
  const JWKS = createRemoteJWKSet(new URL('http://localhost:3000/api/auth/jwks'))
 
  try{
    const {payload} = await jwtVerify(token, JWKS)
    next()

  }catch{
    return res.status(500).send({msg: 'server error!'})
  }

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

app.get('/books/:id', verifyToken,  async(req, res) => {
  
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
