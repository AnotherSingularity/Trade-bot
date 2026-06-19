CREATE TABLE `activity_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`type` enum('scan','signal','trade','system','error') NOT NULL,
	`token` varchar(20),
	`action` varchar(50) NOT NULL,
	`detail` text NOT NULL,
	`tokensScanned` int,
	`passedVolumeFilter` int,
	`passedSignalThreshold` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `activity_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bot_config` (
	`id` int AUTO_INCREMENT NOT NULL,
	`isRunning` boolean NOT NULL DEFAULT false,
	`isPaused` boolean NOT NULL DEFAULT false,
	`consecutiveLosses` int NOT NULL DEFAULT 0,
	`circuitBreakerUntil` timestamp,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bot_config_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `positions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`token` varchar(20) NOT NULL,
	`mode` enum('reversion','breakout','macro') NOT NULL,
	`entryPrice` decimal(20,8) NOT NULL,
	`quantity` decimal(20,8) NOT NULL,
	`allocationPct` decimal(5,2) NOT NULL,
	`takeProfitPrice` decimal(20,8) NOT NULL,
	`stopLossPrice` decimal(20,8) NOT NULL,
	`takeProfitPct` decimal(5,2) NOT NULL,
	`stopLossPct` decimal(5,2) NOT NULL,
	`claudeReason` text,
	`coinbaseOrderId` varchar(128),
	`status` enum('open','closed') NOT NULL DEFAULT 'open',
	`openedAt` timestamp NOT NULL DEFAULT (now()),
	`closedAt` timestamp,
	CONSTRAINT `positions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `token_stats` (
	`id` int AUTO_INCREMENT NOT NULL,
	`token` varchar(20) NOT NULL,
	`totalTrades` int NOT NULL DEFAULT 0,
	`wins` int NOT NULL DEFAULT 0,
	`losses` int NOT NULL DEFAULT 0,
	`winRate` decimal(5,2) NOT NULL DEFAULT '0',
	`isActive` boolean NOT NULL DEFAULT true,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `token_stats_id` PRIMARY KEY(`id`),
	CONSTRAINT `token_stats_token_unique` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE TABLE `trades` (
	`id` int AUTO_INCREMENT NOT NULL,
	`token` varchar(20) NOT NULL,
	`mode` enum('reversion','breakout','macro') NOT NULL,
	`side` enum('buy','sell') NOT NULL,
	`entryPrice` decimal(20,8),
	`exitPrice` decimal(20,8),
	`quantity` decimal(20,8) NOT NULL,
	`pnlDollars` decimal(10,4),
	`pnlPct` decimal(8,4),
	`outcome` enum('win','loss','open') NOT NULL DEFAULT 'open',
	`claudeReason` text,
	`coinbaseOrderId` varchar(128),
	`executedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `trades_id` PRIMARY KEY(`id`)
);
