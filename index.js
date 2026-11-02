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
const borrowsCollection = db.collection("borrows");

// One active borrow per user per book. Returning the book deletes the record,
// so the unique pair can be reused after a return. If duplicates already exist
// from earlier data, index creation fails — log it instead of crashing the API.
try {
  await borrowsCollection.createIndex(
    { bookId: 1, userEmail: 1 },
    { unique: true },
  );
} catch (error) {
  console.error("Could not create unique borrow index:", error);
}

// Older records may have stored `totalCopies` as a string (the Add Book form
// used to post form values directly). $inc only works on numbers, so normalise
// any string/missing values once at startup.
try {
  await booksCollection.updateMany(
    {
      $or: [
        { totalCopies: { $type: "string" } },
        { totalCopies: { $exists: false } },
      ],
    },
    [
      {
        $set: {
          totalCopies: {
            $let: {
              vars: {
                parsed: {
                  $convert: {
                    input: "$totalCopies",
                    to: "int",
                    onError: 0,
                    onNull: 1,
                  },
                },
              },
              in: { $cond: [{ $gt: ["$$parsed", 0] }, "$$parsed", 1] },
            },
          },
        },
      },
    ],
  );
} catch (error) {
  console.error("Could not normalise totalCopies values:", error);
}

/* -------------------- Add Book -------------------- */

app.post("/add-books", verifyToken, async (req, res) => {
  try {
    const data = req.body ?? {};

    const title = String(data.title ?? "").trim();
    const author = String(data.author ?? "").trim();
    const totalCopies = Number(data.totalCopies);

    if (!title || !author) {
      return res.status(400).json({
        success: false,
        message: "Title and author are required",
      });
    }

    if (!Number.isInteger(totalCopies) || totalCopies < 1) {
      return res.status(400).json({
        success: false,
        message: "Total copies must be a whole number of at least 1",
      });
    }

    // Ownership always comes from the verified token — never from the request
    // body, which a client could forge.
    const book = {
      ...data,
      title,
      author,
      totalCopies,
      userName: req.user.name ?? data.userName ?? "",
      userEmail: req.user.email,
      createdAt: new Date(),
    };

    delete book._id;

    const result = await booksCollection.insertOne(book);

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

/* -------------------- Borrow Book -------------------- */

const LOAN_PERIOD_DAYS = 7;

app.post("/books/:id/borrow", verifyToken, async (req, res) => {
  const { id } = req.params;

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid book ID",
    });
  }

  const userEmail = req.user.email;

  if (!userEmail) {
    return res.status(403).json({
      success: false,
      message: "User email not found in token",
    });
  }

  const bookId = new ObjectId(id);

  try {
    // Reject a second simultaneous borrow before touching the stock count.
    const existing = await borrowsCollection.findOne({ bookId, userEmail });

    if (existing) {
      return res.status(409).json({
        success: false,
        code: "ALREADY_BORROWED",
        message: "You have already borrowed this book.",
      });
    }

    // Atomic decrement: only matches while at least one copy is available.
    const book = await booksCollection.findOneAndUpdate(
      { _id: bookId, totalCopies: { $gt: 0 } },
      { $inc: { totalCopies: -1 } },
      { returnDocument: "after" },
    );

    if (!book) {
      const exists = await booksCollection.findOne(
        { _id: bookId },
        { projection: { totalCopies: 1 } },
      );

      if (!exists) {
        return res.status(404).json({
          success: false,
          message: "Book not found",
        });
      }

      return res.status(409).json({
        success: false,
        code: "OUT_OF_STOCK",
        message: "No copies of this book are available right now.",
      });
    }

    const borrowedAt = new Date();
    const dueAt = new Date(
      borrowedAt.getTime() + LOAN_PERIOD_DAYS * 24 * 60 * 60 * 1000,
    );

    try {
      const borrow = await borrowsCollection.insertOne({
        bookId,
        userEmail,
        borrowedAt,
        dueAt,
      });

      return res.status(201).json({
        success: true,
        message: "Book borrowed successfully",
        book,
        borrow: {
          id: String(borrow.insertedId),
          bookId: String(bookId),
          borrowedAt,
          dueAt,
        },
      });
    } catch (error) {
      // A concurrent request won the race after our existence check: put the
      // copy back so the count stays correct.
      await booksCollection.updateOne(
        { _id: bookId },
        { $inc: { totalCopies: 1 } },
      );

      if (error?.code === 11000) {
        return res.status(409).json({
          success: false,
          code: "ALREADY_BORROWED",
          message: "You have already borrowed this book.",
        });
      }

      throw error;
    }
  } catch (error) {
    console.error("Borrow book error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to borrow book",
    });
  }
});

/* -------------------- Return Book -------------------- */

app.post("/books/:id/return", verifyToken, async (req, res) => {
  const { id } = req.params;

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid book ID",
    });
  }

  const userEmail = req.user.email;

  if (!userEmail) {
    return res.status(403).json({
      success: false,
      message: "User email not found in token",
    });
  }

  const bookId = new ObjectId(id);

  try {
    // findOneAndDelete makes the return idempotent-safe: only the request that
    // actually removes the borrow record increments the stock.
    const borrow = await borrowsCollection.findOneAndDelete({
      bookId,
      userEmail,
    });

    if (!borrow) {
      return res.status(404).json({
        success: false,
        code: "NOT_BORROWED",
        message: "You have not borrowed this book.",
      });
    }

    const book = await booksCollection.findOneAndUpdate(
      { _id: bookId },
      { $inc: { totalCopies: 1 } },
      { returnDocument: "after" },
    );

    return res.status(200).json({
      success: true,
      message: "Book returned successfully",
      book,
    });
  } catch (error) {
    console.error("Return book error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to return book",
    });
  }
});

/* -------------------- My Borrows -------------------- */

app.get("/borrows", verifyToken, async (req, res) => {
  const userEmail = req.user.email;

  if (!userEmail) {
    return res.status(403).json({
      success: false,
      message: "User email not found in token",
    });
  }

  try {
    const borrows = await borrowsCollection
      .find({ userEmail })
      .sort({ borrowedAt: -1 })
      .toArray();

    const bookIds = borrows.map((borrow) => borrow.bookId);
    const books = await booksCollection
      .find({ _id: { $in: bookIds } })
      .toArray();
    const booksById = new Map(books.map((book) => [String(book._id), book]));

    const result = borrows.map((borrow) => {
      const book = booksById.get(String(borrow.bookId));

      return {
        id: String(borrow._id),
        bookId: String(borrow.bookId),
        title: book?.title ?? "Unknown book",
        image: book?.image ?? "",
        borrowDate: borrow.borrowedAt,
        returnDate: borrow.dueAt,
        userEmail: borrow.userEmail,
      };
    });

    res.status(200).json(result);
  } catch (error) {
    console.error("Get borrows error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch borrows",
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

    const userEmail = req.user.email;

    if (!userEmail) {
      return res.status(403).json({
        success: false,
        message: "User email not found in token",
      });
    }

    const bookId = new ObjectId(id);

    // Only the user who added the book may delete it.
    const result = await booksCollection.deleteOne({
      _id: bookId,
      userEmail,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Book not found",
      });
    }

    // Remove any active borrows for the deleted book so they don't linger.
    await borrowsCollection.deleteMany({ bookId });

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

export default app;