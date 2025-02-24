import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, test, expect, beforeAll } from '@jest/globals';
import dotenv from 'dotenv';

// Try to load .env from current directory and parent directory
const loadEnv = () => {
    // First try local directory
    const localEnvPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(localEnvPath)) {
        dotenv.config({ path: localEnvPath });
        console.log('Loaded .env from:', localEnvPath);
    }

    // Then try parent directory
    const parentEnvPath = path.join(process.cwd(), '..', '.env');
    if (fs.existsSync(parentEnvPath)) {
        dotenv.config({ path: parentEnvPath });
        console.log('Loaded .env from:', parentEnvPath);
    }
};

loadEnv();

describe('Gmail Content Tests', () => {
    let oauth2Client: OAuth2Client;
    const CONFIG_DIR = path.join(os.homedir(), '.gmail-mcp');
    const CREDENTIALS_PATH = process.env.GMAIL_CREDENTIALS_PATH || path.join(CONFIG_DIR, 'credentials.json');
    const OAUTH_PATH = process.env.GMAIL_OAUTH_PATH || path.join(CONFIG_DIR, 'gcp-oauth.keys.json');

    beforeAll(async () => {
        // Load OAuth credentials
        const keysContent = JSON.parse(fs.readFileSync(OAUTH_PATH, 'utf8'));
        const keys = keysContent.installed || keysContent.web;
        
        oauth2Client = new OAuth2Client(
            keys.client_id,
            keys.client_secret,
            'http://localhost:3000/oauth2callback'
        );

        // Load existing tokens
        if (fs.existsSync(CREDENTIALS_PATH)) {
            const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
            oauth2Client.setCredentials(credentials);
        } else {
            throw new Error('Credentials not found. Please run authentication first.');
        }
    });

    test('should retrieve full content of recent emails', async () => {
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        
        // Get list of recent messages
        const listResponse = await gmail.users.messages.list({
            userId: 'me',
            maxResults: 5,
            q: 'in:inbox newer_than:2d'
        });

        expect(listResponse.data.messages).toBeDefined();
        expect(Array.isArray(listResponse.data.messages)).toBe(true);
        
        if (!listResponse.data.messages || listResponse.data.messages.length === 0) {
            throw new Error('No recent messages found for testing');
        }

        // Test each message
        for (const message of listResponse.data.messages) {
            const messageResponse = await gmail.users.messages.get({
                userId: 'me',
                id: message.id!,
                format: 'full'
            });

            // Basic message structure checks
            expect(messageResponse.data).toBeDefined();
            expect(messageResponse.data.payload).toBeDefined();
            
            // Extract and check headers
            const headers = messageResponse.data.payload?.headers || [];
            const subject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value;
            const from = headers.find(h => h.name?.toLowerCase() === 'from')?.value;
            
            expect(subject).toBeDefined();
            expect(from).toBeDefined();

            // Extract and check body content
            let body = '';
            const payload = messageResponse.data.payload!;

            // Function to recursively get body from parts
            const getBodyFromParts = (part: any): string => {
                if (part.body?.data) {
                    return Buffer.from(part.body.data, 'base64').toString('utf8');
                }
                
                if (part.parts) {
                    return part.parts.map((p: any) => getBodyFromParts(p)).join('\n');
                }
                
                return '';
            };

            // Get body content
            if (payload.body?.data) {
                body = Buffer.from(payload.body.data, 'base64').toString('utf8');
            } else if (payload.parts) {
                body = getBodyFromParts(payload);
            }

            // Content checks
            expect(body.length).toBeGreaterThan(0);
            console.log(`Email: ${subject}`);
            console.log('Body length:', body.length);
            console.log('First 100 chars:', body.substring(0, 100));
            console.log('---');
        }
    }, 30000); // Increased timeout for API calls
}); 