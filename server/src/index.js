require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const authRoutes = require('./routes/auth');
const materialsRoutes = require('./routes/materials');
const projectsRoutes = require('./routes/projects');
const blueprintRoomsRoutes = require('./routes/blueprintRooms');
const mappedRoomMaterialsRoutes = require('./routes/mappedRoomMaterials');
const ledgerFoldersRoutes = require('./routes/ledgerFolders');
const ledgerItemsRoutes = require('./routes/ledgerItems');

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:8080', credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/materials', materialsRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/projects/:projectId/rooms', blueprintRoomsRoutes);
app.use('/api/projects/:projectId/room-materials', mappedRoomMaterialsRoutes);
app.use('/api/projects/:projectId/ledger-folders', ledgerFoldersRoutes);
app.use('/api/projects/:projectId/ledger-items', ledgerItemsRoutes);

// Centralized error handler so a thrown/rejected error in any route
// returns JSON instead of Express's default HTML error page.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Material Matrix Pro API listening on port ${port}`);
});
