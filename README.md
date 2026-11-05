# StaySuite — Hotel Management System

A full-stack HMS starter built with React, Node.js/Express and PostgreSQL (Prisma).

## Features in this first build
- Dashboard counts for total, occupied, available, reserved and out-of-order rooms.
- Separate housekeeping condition counts: Clean, Dirty and Cleaning.
- Today's arrivals count only confirmed reservations.
- Room inventory with independent occupancy and housekeeping statuses.
- Reservations, guest directory and payment records (Cash, UPI, Card, Online).
- Daily occupied-room housekeeping task generation.
- Room Rack with Daily, Weekly and Monthly timeline views.
- Checkout changes room occupancy to Available and housekeeping condition to Dirty.

## Requirements
- Node.js 20+
- PostgreSQL 14+

## Setup
1. Copy `.env.example` to `.env` in the project root and set your PostgreSQL connection string.
2. Install dependencies: `npm install`
3. Create/update database tables: `npm run db:push`
4. Add starter rooms and guests: `npm run db:seed`
5. Start frontend and API: `npm run dev`
6. Open http://localhost:5173

The API runs at http://localhost:4000. Set `VITE_API_URL` in `client/.env` if the API is hosted elsewhere.

## Important
This is an initial development build. Configure a real PostgreSQL database before use. Authentication/role permissions, audit logs, production payment gateway integration, backups, deployment and comprehensive validation are not yet implemented. Do not use it for live hotel operations until those are completed and tested.
