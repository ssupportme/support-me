# SupportMe — Product Requirements Document (v2)

**Version:** 2.0  
**Date:** April 2026  
**Project:** SupportMe — Creator Tipping & Donation Platform  
**Stack:** Next.js · Stellar SDK · Soroban · PostgreSQL · Prisma

---

# 1. Overview

SupportMe is a decentralized creator monetization platform that enables creators to receive tips, donations, and financial support directly from their fans or communities.

Creators connect their wallet, generate a personalized link, share it publicly, and track all payments received from a dashboard.

Supporters can visit the creator’s page, send a tip, optionally leave a message, and receive confirmation of the transaction.

---

# 2. Product Vision

SupportMe aims to become the simplest way for creators to receive financial support globally using blockchain payments.

The platform focuses on:

- simplicity
- transparency
- fast payments
- direct creator-to-supporter interaction
- shareable monetization links

---

# 3. Goals

- Allow creators to receive tips instantly via wallet payments
- Provide unique shareable donation links
- Enable creators to track earnings in real time
- Support multiple payment currencies
- Build a scalable creator monetization infrastructure

---

# 4. User Roles

## Creator

The individual receiving support.

Examples:

- developer
- content creator
- designer
- educator
- community leader
- student

Creators can:

- connect wallet
- create profile
- generate shareable link
- receive donations
- track payments
- manage profile

---

## Supporter

A fan or community member supporting the creator.

Supporters can:

- visit creator page
- send tip
- leave message
- view confirmation

---

# 5. Core User Flow

## Creator Flow

Connect wallet  
Create profile  
Choose username  
Generate link  
Share link  
Receive tips  
Track payments  

---

## Supporter Flow

Open link  
View creator page  
Enter amount  
Optional message  
Send tip  
Receive confirmation  

---

# 6. Core Features

---

# 6.1 Wallet Connection

Users must be able to connect and disconnect their wallet.

Requirements:

- Detect wallet on page load
- Show "Connect Wallet" button
- Display truncated wallet address after connection
- Allow disconnect
- Handle connection errors

---

# 6.2 Creator Profile

Each creator has a personalized public page.

Route:

/username

Example:

supportme.app/sammie

---

## Profile Components

- avatar
- display name
- bio
- wallet address
- support button
- recent supporters
- donation goal
- social links

---

# 6.3 Unique Shareable Link

Each creator receives a unique link.

Example:

supportme.app/{username}

The link is generated after:

- wallet connection
- username creation

---

# 6.4 Send Tip

Supporters can send a payment to the creator.

Required Inputs:

- amount
- currency
- optional message

---

## Transaction States

idle  
pending  
success  
failed  

---

# 6.5 Tip With Message

Supporters can attach a message to their donation.

Example:

Amount: 5 XLM  

Message:

"Thanks for your work!"

---

# 6.6 Donation Tracking Dashboard

Creators can view all payments received.

Route:

/dashboard

---

## Dashboard Metrics

- total earnings
- number of donations
- unique supporters
- average tip
- largest tip

---

## Dashboard Table

Fields:

- sender address
- amount
- currency
- message
- transaction hash
- date

---

# 6.7 Multiple Currency Support

Supported currencies:

- XLM
- USDC
- USDT
- Custom tokens

Future:

- fiat payments
- cross-chain payments

---

# 6.8 Donation Goal

Creators can set a funding goal.

Example:

Goal Title:

Buy a new laptop

Target:

500 XLM

Progress:

72%

---

# 6.9 Recent Supporters Feed

Display recent donations.

Example:

Tunde sent 5 XLM  
Ada sent 10 XLM  
John sent 3 XLM  

---

# 6.10 Notifications

Creators receive notifications when:

- a donation is received
- a large donation occurs
- a goal is reached

---

## Notification Channels

- in-app
- email
- push notifications

---

# 6.11 QR Code Generator

Automatically generate a QR code for the creator’s page.

Capabilities:

- display QR code
- download QR code
- share QR code

---

# 6.12 Tip Presets

Provide quick payment buttons.

Examples:

1 XLM  
5 XLM  
10 XLM  
Custom  

---

# 6.13 Custom Themes

Creators can customize their page.

Options:

- background color
- accent color
- font
- layout

---

# 6.14 Leaderboard

Display top supporters.

Examples:

Top supporters  
Top creators  
Top communities  

---

# 7. Database Models

---

## Creator

```sql
id
username
walletAddress
displayName
bio
avatarUrl
coverImage
createdAt
updatedAt