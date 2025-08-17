// server.js

require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const session = require("express-session");
const flash = require("connect-flash");
const expressLayouts = require("express-ejs-layouts");

const OpenAI = require("openai");

const apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error(
    "Missing API key: set DEEPSEEK_API_KEY or OPENAI_API_KEY in your .env file"
  );
}

const openai = new OpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: apiKey,
});

const hintTemplate = process.env.DEEPSEEK_HINT_PROMPT;

const app = express();

// Configuration
let nameDB = "cards.db";
const pathDB = path.join(__dirname, "db");

// Set up view engine (EJS). You’ll need to create EJS files in a “templates” folder
// corresponding to the Flask templates (e.g. cards.html → cards.ejs, show.html → show.ejs, etc.)
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");
app.use(expressLayouts);
app.set("layout", "layout"); // default layout file: views/layout.ejs

app.use(express.static(path.join(__dirname, "static"))); // Serve static files from "static" directory

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET, // used to sign the session ID cookie
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false, // true when behind HTTPS
      sameSite: "lax",
      maxAge: 1000 * 60 * 10,
    },
  })
);
// Make session data available to all templates
app.use(flash());

// Expose session and user to all EJS views
app.use((req, res, next) => {
  res.locals.session = req.session;
  res.locals.user = req.session && req.session.user ? req.session.user : null;
  next();
});

// Make flash messages available in all templates
app.use((req, res, next) => {
  res.locals.flash = req.flash();
  next();
});

// ---------------------------------------------------------------------------
// Database connection and helpers
// ---------------------------------------------------------------------------
let db = null;

function connectDB() {
  return new Promise((resolve, reject) => {
    const dbPath = path.join(pathDB, nameDB);
    db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error("Error opening database:", err.message);
        reject(err);
      } else {
        console.log("Connected to SQLite database:", dbPath);
        resolve();
      }
    });
  });
}
//connectDB();  // moved into startServer()

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

async function ensureUsersTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// Ensure the user is logged in
function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }
  next();
}

// ---------------------------------------------------------------------------
// Tag helpers
// ---------------------------------------------------------------------------
async function getAllTag() {
  return await query("SELECT id, tagName FROM tags ORDER BY id ASC");
}

async function getTagById(tag_id) {
  return await get("SELECT id, tagName FROM tags WHERE id = ?", [tag_id]);
}

async function checkTableTagExists() {
  return await get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='tags'"
  );
}

async function createTagTable() {
  const sql = `
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tagName TEXT NOT NULL
    );
  `;
  await run(sql, []);
}

async function initTag() {
  await run("INSERT INTO tags (tagName) VALUES (?)", ["general"]);
  await run("INSERT INTO tags (tagName) VALUES (?)", ["code"]);
  await run("INSERT INTO tags (tagName) VALUES (?)", ["bookmark"]);
}

// ---------------------------------------------------------------------------
// Card helpers
// ---------------------------------------------------------------------------
async function getCard(type) {
  return await get(
    `
    SELECT id, type, front, back, known
    FROM cards
    WHERE type = ?
      AND known = 0
    ORDER BY RANDOM()
    LIMIT 1
  `,
    [type]
  );
}

async function getCardById(card_id) {
  return await get(
    `
    SELECT id, type, front, back, known
    FROM cards
    WHERE id = ?
    LIMIT 1
  `,
    [card_id]
  );
}

async function getAnyUnknownCard() {
  return await get(
    `
    SELECT id, type, front, back, known
    FROM cards
    WHERE known = 0
    ORDER BY RANDOM()
    LIMIT 1
  `
  );
}

async function getCardAlreadyKnown(type) {
  return await get(
    `
    SELECT id, type, front, back, known
    FROM cards
    WHERE type = ?
      AND known = 1
    ORDER BY RANDOM()
    LIMIT 1
  `,
    [type]
  );
}

// ---------------------------------------------------------------------------
// Initialize database schema
// ---------------------------------------------------------------------------
async function initDB() {
  const schemaPath = path.join(__dirname, "data", "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");

  return new Promise((resolve, reject) => {
    db.exec(schema, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
``;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// “/” and “/cards”: show all cards (requires login)
app.get(["/", "/cards"], requireLogin, async (req, res) => {
  try {
    const cards = await query(`
      SELECT id, type, front, back, known
      FROM cards
      ORDER BY id DESC
    `);
    const tags = await getAllTag();
    res.render("cards", { cards, tags, filter_name: "all" });
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// Filter cards by “all”, “general”, “code”, “known”, “unknown”, or a numeric type
app.get("/filter_cards/:filter_name", requireLogin, async (req, res) => {
  const filter_name = req.params.filter_name;
  const filters = {
    all: "WHERE 1 = 1",
    general: "WHERE type = 1",
    code: "WHERE type = 2",
    known: "WHERE known = 1",
    unknown: "WHERE known = 0",
  };
  let queryFilter = filters[filter_name];
  let displayFilter = filter_name;
  if (!queryFilter) {
    // If it’s not one of the named filters, treat it as a tag/type ID
    queryFilter = `WHERE type = ${filter_name}`;
    displayFilter = parseInt(filter_name);
  }

  try {
    const cards = await query(`
      SELECT id, type, front, back, known
      FROM cards
      ${queryFilter}
      ORDER BY id DESC
    `);
    const tags = await getAllTag();
    res.render("show", { cards, tags, filter_name: displayFilter });
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// Add a new card (type, front, back)
app.post("/add", requireLogin, async (req, res) => {
  try {
    await run("INSERT INTO cards (type, front, back) VALUES (?, ?, ?)", [
      req.body.type,
      req.body.front,
      req.body.back,
    ]);
    req.flash("success", "New card was successfully added.");
    res.redirect("/cards");
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// Show edit form for a given card
app.get("/edit/:card_id", requireLogin, async (req, res) => {
  const card_id = req.params.card_id;
  try {
    const card = await getCardById(card_id);
    const tags = await getAllTag();
    res.render("edit", { card, tags });
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// Handle “save” from the edit form
app.post("/edit-card", requireLogin, async (req, res) => {
  try {
    await run(
      "UPDATE cards SET type = ?, front = ?, back = ?, known = ? WHERE id = ?",
      [
        parseInt(req.body.type, 10),
        req.body.front,
        req.body.back,
        parseInt(req.body.known, 10) || 0, // default to 0 if not provided
        parseInt(req.body.card_id, 10), // or req.body.id if that's what you're using
      ]
    );
    req.flash("success", "Card saved.");
    res.redirect("/show");
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// Delete a card
app.get("/delete/:card_id", requireLogin, async (req, res) => {
  const card_id = req.params.card_id;
  try {
    await run("DELETE FROM cards WHERE id = ?", [card_id]);
    req.flash("success", "Card deleted.");
    res.redirect("/cards");
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// “Memorize” unknown cards of a given type (default type = 1)
// If card_id is provided, just fetch that specific card; otherwise pick a random unknown.
app.get(
  ["/memorize", "/memorize/:card_type", "/memorize/:card_type/:card_id"],
  requireLogin,
  async (req, res) => {
    let card_type = req.params.card_type;
    const card_id = req.params.card_id;

    try {
      let card;

      if (card_id) {
        card = await getCardById(card_id);
      } else if (card_type) {
        card = await getCard(card_type); // still filtered by type
      } else {
        // No type specified → get ANY unknown card
        card = await getAnyUnknownCard();
      }

      if (!card) {
        req.flash(
          "info",
          card_type
            ? `You've learned all the cards of this type.`
            : `You've learned all unknown cards.`
        );
        return res.redirect("/show");
      }

      card_type = card.type;
      const short_answer = card.back.length < 75;
      const tags = await getAllTag();
      console.log(
        `Memorizing card: ${card.id}, type: ${card_type}, front: ${card.front}`
      );

      res.render("memorize", {
        card,
        card_type: card_type ? parseInt(card_type) : null,
        short_answer,
        tags,
      });
    } catch (err) {
      console.error(err);
      res.sendStatus(500);
    }
  }
);

// “Memorize known” (review) cards of a given type
app.get(
  [
    "/memorize_known",
    "/memorize_known/:card_type",
    "/memorize_known/:card_type/:card_id",
  ],
  requireLogin,
  async (req, res) => {
    const card_type = req.params.card_type || 1;
    const card_id = req.params.card_id;
    try {
      let card;
      if (card_id) {
        card = await getCardAlreadyKnown(card_id);
      } else {
        card = await getCardAlreadyKnown(card_type);
      }

      if (!card) {
        // No more known cards to review
        const tag = await getTagById(card_type);
        req.flash(
          "info",
          `You've no more known '${tag.tagName}' cards to review.`
        );
        return res.redirect("/show");
      }

      const short_answer = card.back.length < 75;
      const tags = await getAllTag();
      res.render("memorize_known", {
        card,
        card_type: parseInt(card_type),
        short_answer,
        tags,
      });
    } catch (err) {
      console.error(err);
      res.sendStatus(500);
    }
  }
);

// Mark a card as known
app.get("/mark-known/:card_id/:card_type", requireLogin, async (req, res) => {
  const { card_id, card_type } = req.params;
  try {
    await run("UPDATE cards SET known = 1 WHERE id = ?", [card_id]);
    req.flash("success", "Card marked as known.");
    res.redirect(`/memorize/${card_type}`);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// Mark a card as unknown (for review again)
app.get("/mark_unknown/:card_id/:card_type", requireLogin, async (req, res) => {
  const { card_id, card_type } = req.params;
  try {
    await run("UPDATE cards SET known = 0 WHERE id = ?", [card_id]);
    req.flash("success", "Card marked as unknown.");
    res.redirect(`/memorize_known/${card_type}`);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// ---------------------------------------------------------------------------
// AI Hint Feature
// ---------------------------------------------------------------------------
// Load the template from env

/**
 * Fill in the template with real values.
 * @param {string} front - The flashcard front text
 * @param {string} back - The flashcard back text
 * @returns {string} - The filled prompt
 */
function buildHintPrompt(front, back) {
  return hintTemplate
    .replace("{front_message}", front)
    .replace("{back_message}", back);
}

async function getAIHintForCard(card) {
  try {
    // Verify card existence
    if (!card) {
      throw new Error("Card not found");
    }
    console.log(card);
    // Build the prompt using the template
    const prompt = buildHintPrompt(card.front, card.back);
    const completion = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful mentor who gives concise, recall-friendly hints for flashcards.",
        },
        { role: "user", content: prompt },
      ],
    });
    console.log(completion.choices[0].message.content);
    return completion.choices[0].message.content;
  } catch (error) {
    console.error("Error verifying card existence:", error);
    throw error;
  }
}

app.get("/hint/:card_id", requireLogin, async (req, res) => {
  const card_id = req.params.card_id;
  try {
    const card = await getCardById(card_id);
    if (!card) {
      return res.status(404).json({ error: "Card not found" });
    }
    const hint = await getAIHintForCard(card);
    res.json({ hint });
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// ---------------------------------------------------------------------------
// Authentication routes
// ---------------------------------------------------------------------------

// Show login form
app.get("/login", (req, res) => {
  res.render("login", { error: null, signup: false });
});

// Show signup form
app.get("/signup", (req, res) => {
  res.render("login", { error: null, signup: true });
});

// Handle login POST
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  // Query from data base by username and password to verify the identity
  try {
    const rows = await query(
      "SELECT * FROM users WHERE username = ? AND password = ?",
      [username, password]
    );
    const user = rows && rows.length > 0 ? rows[0] : null;
    if (user) {
      req.session.user = user.username;
      console.log(`User logged in: ${user.username}`);
      return res.redirect("/list_db");
    }
    return res.render("login", {
      error: "Invalid username or password!",
      signup: false,
    });
  } catch (err) {
    console.error(err);
    return res.render("login", { error: "Login failed!", signup: false });
  }
});

// Handle signup POST
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  // Create a tuple in data base for the user
  // Handle the error if SQL query fails
  try {
    // Check if username exists
    const existingUser = await query("SELECT * FROM users WHERE username = ?", [
      username,
    ]);
    if (existingUser.length > 0) {
      return res.render("login", {
        error: "Username already exists!",
        signup: true,
      });
    }

    await run("INSERT INTO users (username, password) VALUES (?, ?)", [
      username,
      password,
    ]);
    console.log(`User created: ${username}`);
    req.session.user = username;
    res.redirect("/list_db");
  } catch (err) {
    console.error(err);
    return res.render("login", { error: "Signup failed!", signup: true });
  }
});

// Logout
app.get("/logout", requireLogin, (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).send("Error logging out");
    }
    res.clearCookie("connect.sid"); // clear the session ID cookie
    return res.redirect("/login");
  });
});

// ---------------------------------------------------------------------------
// Tag management routes
// ---------------------------------------------------------------------------

// List all tags
app.get("/tags", requireLogin, async (req, res) => {
  try {
    const tags = await getAllTag();
    res.render("tags", { tags, filter_name: "all" });
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// Add a new tag
app.post("/add-tag", requireLogin, async (req, res) => {
  try {
    await run("INSERT INTO tags (tagName) VALUES (?)", [req.body.tagName]);
    req.flash("success", "New tag was successfully added.");
    res.redirect("/tags");
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// Show edit form for a tag
// query parameter
app.get("/edit-tag", requireLogin, async (req, res) => {
  const tag_id = req.query.tag_id;
  try {
    const tag = await getTagById(tag_id);
    res.render("editTag", { tag });
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// Update a tag
app.post("/update-tag", requireLogin, async (req, res) => {
  try {
    await run("UPDATE tags SET tagName = ? WHERE id = ?", [
      req.body.tagName,
      req.body.tag_id,
    ]);
    req.flash("success", "Tag saved.");
    res.redirect("/tags");
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// “Show” route (mirrors Flask’s /show, simply renders tags page)
app.get("/show", requireLogin, async (req, res) => {
  const tags = await getAllTag();
  const cards = await query(`
  SELECT id, type, front, back, known
  FROM cards
  ORDER BY id DESC
  `);

  res.render("show", { cards, tags, filter_name: "" });
});

// Bookmark a card by changing its type
app.get("/bookmark/:card_type/:card_id", requireLogin, async (req, res) => {
  const { card_type, card_id } = req.params;
  try {
    await run("UPDATE cards SET type = ? WHERE id = ?", [card_type, card_id]);
    req.flash("success", "Card saved.");
    res.redirect(`/memorize/${card_type}`);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// ---------------------------------------------------------------------------
// Database‐management routes (switch / create DB files)
// ---------------------------------------------------------------------------

// List all .db files in the “db” directory
app.get("/list_db", requireLogin, (req, res) => {
  fs.readdir(pathDB, (err, files) => {
    if (err) {
      console.error(err);
      return res.sendStatus(500);
    }
    const dbs = files.filter((f) => f.endsWith(".db"));
    res.render("listDb", { dbs });
  });
});

// Load (switch to) another database file
app.get("/load_db/:name", requireLogin, async (req, res) => {
  const name = req.params.name;
  try {
    nameDB = name;
    // Close current DB and reconnect to the new one
    db.close();
    await connectDB();
    // Ensure users table exists for the newly loaded DB
    await ensureUsersTable();

    // If tags table doesn’t exist, create it and initialize default tags
    // Inside /load_db/:name or /init or server start
    const exists = await checkTableTagExists();
    if (!exists) {
      await createTagTable(); // <--- creates the tags table
      await initTag(); // <--- inserts initial tags
    }

    res.redirect("/memorize/1");
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// Show form to create a new database
app.get("/create_db", requireLogin, (req, res) => {
  res.render("createDb");
});

// Initialize a brand‐new database (schema + default tags)
app.post("/init", requireLogin, async (req, res) => {
  const dbName = req.body.dbName;
  try {
    nameDB = dbName + ".db";
    // Reconnect to this new file
    db.close();
    await connectDB();
    // Ensure users table exists for the newly created DB
    await ensureUsersTable();

    // Initialize schema (data/schema.sql) and default tags
    await initDB();
    await initTag();
    res.redirect("/");
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// ---------------------------------------------------------------------------
// Start everything
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;

async function startServer() {
  // Connect to DB
  await connectDB();

  // Ensure users table exists (for auth)
  await ensureUsersTable();

  // Ensure tags table exists and is initialized
  try {
    const exists = await checkTableTagExists();
    if (!exists) {
      await initDB(); // Initialize schema if it doesn't exist
      await createTagTable();
      await initTag();
    }
  } catch (err) {
    console.error("Error during tags table initialization:", err);
    process.exit(1);
  }

  // Start server
  app.listen(PORT, () => {
    console.log(`Express server listening on port ${PORT}`);
  });
}

startServer();
