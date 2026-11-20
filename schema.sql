-- Live state of every seat across all 3 floors
CREATE TABLE seats (
  id          VARCHAR(16) PRIMARY KEY, -- e.g., 'F1-S1'
  floor       INT NOT NULL,
  zone        VARCHAR(32) NOT NULL,
  qr_secret   VARCHAR(64) NOT NULL,    -- Printed in the physical desk QR code
  status      VARCHAR(16) NOT NULL DEFAULT 'available', -- available | reserved | occupied | break
  occupant_id VARCHAR(64),
  expires_at  TIMESTAMP                -- Used for 5-min QR grace period & 20-min break
);

-- Append-only log for Admin Analytics (peak hours & hogged seats)
CREATE TABLE booking_events (
  id          SERIAL PRIMARY KEY,
  seat_id     VARCHAR(16) REFERENCES seats(id),
  student_id  VARCHAR(64),
  event_type  VARCHAR(24) NOT NULL,    -- RESERVED | CHECKED_IN | BREAK_START | AUTO_RELEASE | CHECKED_OUT | CONFLICT_409
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);