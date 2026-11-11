CREATE DATABASE IF NOT EXISTS resq_it
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE resq_it;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  full_name VARCHAR(120) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('user', 'admin') NOT NULL DEFAULT 'user',
  phone_number VARCHAR(40) NULL,
  emergency_contact_name VARCHAR(120) NULL,
  emergency_contact_number VARCHAR(40) NULL,
  token_version INT UNSIGNED NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_role (role)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS emergency_reports (
  id CHAR(36) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  category ENUM('medical', 'fire', 'police', 'accident', 'disaster', 'other') NOT NULL,
  description VARCHAR(2000) NULL,
  latitude DECIMAL(10, 7) NULL,
  longitude DECIMAL(10, 7) NULL,
  status ENUM('Submitted', 'Under Review', 'Resolved', 'Closed') NOT NULL DEFAULT 'Submitted',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_reports_user_created (user_id, created_at),
  CONSTRAINT fk_reports_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS facility_suggestions (
  id CHAR(36) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  facility_name VARCHAR(200) NOT NULL,
  facility_type VARCHAR(80) NOT NULL,
  address VARCHAR(300) NULL,
  latitude DECIMAL(10, 7) NOT NULL,
  longitude DECIMAL(10, 7) NOT NULL,
  contact_number VARCHAR(40) NULL,
  source_url VARCHAR(2048) NULL,
  review_status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  review_note VARCHAR(1000) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  KEY idx_suggestions_user_created (user_id, created_at),
  KEY idx_suggestions_review (review_status, created_at),
  CONSTRAINT fk_suggestions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;
