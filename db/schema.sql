-- YehMee booking: MariaDB tables. Safe to run again (only creates what is missing).
-- Times like created_at are UTC; expires_at is milliseconds since 1970, as in the app.

CREATE TABLE IF NOT EXISTS users (
  id            VARCHAR(32)  NOT NULL PRIMARY KEY,
  name          VARCHAR(80)  NOT NULL,
  email         VARCHAR(200) NOT NULL UNIQUE,
  phone         VARCHAR(30)  NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(16)  NULL,
  created_at    DATETIME(3)  NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64)    NOT NULL PRIMARY KEY,
  user_id    VARCHAR(32) NOT NULL,
  expires_at BIGINT      NOT NULL,
  KEY sessions_user (user_id),
  CONSTRAINT sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS resets (
  token_hash CHAR(64)    NOT NULL PRIMARY KEY,
  user_id    VARCHAR(32) NOT NULL,
  expires_at BIGINT      NOT NULL,
  KEY resets_user (user_id),
  CONSTRAINT resets_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bookings (
  id               VARCHAR(32)  NOT NULL PRIMARY KEY,
  user_id          VARCHAR(32)  NOT NULL,
  service_id       VARCHAR(80)  NOT NULL,
  service_name     VARCHAR(200) NOT NULL,
  duration_min     INT          NOT NULL,
  price_eur        DECIMAL(8,2) NOT NULL,
  date             DATE         NOT NULL,
  time             CHAR(5)      NOT NULL,
  start_min        INT          NOT NULL,
  end_min          INT          NOT NULL,
  end_time         CHAR(5)      NOT NULL,
  note             VARCHAR(500) NOT NULL DEFAULT '',
  payment_method   VARCHAR(16)  NOT NULL,
  voucher_code     VARCHAR(64)  NULL,
  deposit_eur      DECIMAL(8,2) NOT NULL,
  status           VARCHAR(16)  NOT NULL,
  created_at       DATETIME(3)  NOT NULL,
  cancelled_at     DATETIME(3)  NULL,
  deposit_refunded BOOLEAN      NULL,
  KEY bookings_user (user_id),
  KEY bookings_day (date, status),
  CONSTRAINT bookings_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS vouchers (
  code    VARCHAR(64)  NOT NULL PRIMARY KEY,
  note    VARCHAR(200) NULL,
  used_by VARCHAR(32)  NULL,
  CONSTRAINT vouchers_booking FOREIGN KEY (used_by) REFERENCES bookings (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_images (
  service_id  VARCHAR(80)  NOT NULL PRIMARY KEY,
  file        VARCHAR(200) NOT NULL,
  uploaded_at DATETIME(3)  NOT NULL,
  uploaded_by VARCHAR(32)  NOT NULL,
  CONSTRAINT service_images_user FOREIGN KEY (uploaded_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- seq keeps the upload order (the gallery shows the newest first)
CREATE TABLE IF NOT EXISTS gallery_uploads (
  seq         INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  id          VARCHAR(32)  NOT NULL UNIQUE,
  section     VARCHAR(16)  NOT NULL,
  file        VARCHAR(200) NOT NULL,
  uploaded_at DATETIME(3)  NOT NULL,
  uploaded_by VARCHAR(32)  NOT NULL,
  CONSTRAINT gallery_uploads_user FOREIGN KEY (uploaded_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Built-in photos the admin has hidden
CREATE TABLE IF NOT EXISTS gallery_hidden (
  photo_id VARCHAR(80) NOT NULL PRIMARY KEY
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
