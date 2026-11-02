import express from "express";
import "dotenv/config";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();
const PORT = process.env.PORT || 7000;

app.use(cors());
app.use(express.json());

/* -------------------- Authentication Middleware -------------------- */

const JWKS = createRemoteJWKSet(new URL(`${process.env.CLIENT_URL}/api/auth/jwks`));

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized: Token missing",
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    const { payload } = await jwtVerify(token, JWKS);

    req.user = payload;
    next();
  } catch (error) {
    console.error("Token verification failed:", error);

    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
};

/* -------------------- MongoDB Connection -------------------- */

const client = new MongoClient(process.env.MONGODB_URI);

await client.connect();

console.log("MongoDB connected successfully!");

const db = client.db("book-nook");
const booksCollection = db.collection("books");

/* -------------------- Add Book -------------------- */

app.post("/add-books", verifyToken, async (req, res) => {
  try {
    const data = req.body;

    const result = await booksCollection.insertOne(data);

    res.status(201).json({
      success: true,
      message: "Book added successfully",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("Add book error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to add book",
    });
  }
});

/* -------------------- Get All Books -------------------- */

app.get("/books", async (req, res) => {
  try {
    const result = await booksCollection.find().toArray();

    res.status(200).json(result);
  } catch (error) {
    console.error("Get books error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch books",
    });
  }
});

/* -------------------- Get Single Book -------------------- */

app.get("/books/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid book ID",
      });
    }

    const book = await booksCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!book) {
      return res.status(404).json({
        success: false,
        message: "Book not found",
      });
    }

    res.status(200).json(book);
  } catch (error) {
    console.error("Get single book error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch book",
    });
  }
});

/* -------------------- UPDATE BOOK (EDIT) -------------------- */

app.patch("/books/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid book ID",
      });
    }

    const { title, author, category, totalCopies, image, description } =
      req.body;

    // Validate required fields
    if (!title?.trim() || !author?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Title and author are required",
      });
    }

    if (!Number.isInteger(totalCopies) || totalCopies < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid total copies",
      });
    }

    // Only update allowed fields
    const updateData = {
      title: title.trim(),
      author: author.trim(),
      category,
      totalCopies,
      image: image || "",
      description: description || "",
      updatedAt: new Date(),
    };

    const userEmail = req.user.email;

    if (!userEmail) {
      return res.status(403).json({
        success: false,
        message: "User email not found in token",
      });
    }

    const result = await booksCollection.updateOne(
      {
        _id: new ObjectId(id),
        userEmail: userEmail,
      },
      {
        $set: updateData,
      },
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Book not found",
      });
    }

    // Get updated book from MongoDB
    const updatedBook = await booksCollection.findOne({
      _id: new ObjectId(id),
    });

    res.status(200).json({
      success: true,
      message: "Book updated successfully",
      book: updatedBook,
    });
  } catch (error) {
    console.error("Update book error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to update book",
    });
  }
});

/* -------------------- DELETE BOOK -------------------- */

app.delete("/books/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid book ID",
      });
    }

    const result = await booksCollection.deleteOne({
      _id: new ObjectId(id),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Book not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Book deleted successfully",
    });
  } catch (error) {
    console.error("Delete book error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to delete book",
    });
  }
});

/* -------------------- Home Route -------------------- */

app.get("/", (req, res) => {
  res.send("BookNook API is running!");
});

/* -------------------- Server -------------------- */

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
