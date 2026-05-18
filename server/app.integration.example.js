'use strict';

// ตัวอย่างการต่อเข้ากับ Express เดิม
// ปรับ path db ให้ตรงกับโปรเจกต์จริงของคุณ

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./db');
const { makeMt5Realtime } = require('./server/realtime/mt5Realtime');
const buildMt5Routes = require('./server/routes/app-mt5-bot');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });
const realtime = makeMt5Realtime(io);
realtime.attachAuth();

app.use(buildMt5Routes({ db, realtime }));

server.listen(3000, () => console.log('Avelqua MT5 server ready'));
