#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from 'googleapis';
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import open from 'open';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration paths
const CONFIG_DIR = path.join(os.homedir(), '.gmail-mcp');
const OAUTH_PATH = process.env.GMAIL_OAUTH_PATH || path.join(CONFIG_DIR, 'gcp-oauth.keys.json');
const CREDENTIALS_PATH = process.env.GMAIL_CREDENTIALS_PATH || path.join(CONFIG_DIR, 'credentials.json');

// Default output directory for sent emails
const DEFAULT_SENT_EMAILS_DIR = process.env.GMAIL_SENT_EMAILS_DIR || path.join(process.cwd(), 'sent-emails');

// Signature configuration
const SIGNATURE_TEMPLATE = process.env.GMAIL_SIGNATURE_TEMPLATE || '\n\nBest regards,\n{name}';  // Set to empty string to disable

// OAuth2 configuration
let oauth2Client: OAuth2Client;
let userProfile: { name: string; email: string; } | null = null;

async function loadCredentials() {
    try {
        // Create config directory if it doesn't exist
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }

        // Check for OAuth keys in current directory first, then in config directory
        const localOAuthPath = path.join(process.cwd(), 'gcp-oauth.keys.json');
        let oauthPath = OAUTH_PATH;
        
        if (fs.existsSync(localOAuthPath)) {
            // If found in current directory, copy to config directory
            fs.copyFileSync(localOAuthPath, OAUTH_PATH);
            console.log('OAuth keys found in current directory, copied to global config.');
        }

        if (!fs.existsSync(OAUTH_PATH)) {
            console.error('Error: OAuth keys file not found. Please place gcp-oauth.keys.json in current directory or', CONFIG_DIR);
            process.exit(1);
        }

        const keysContent = JSON.parse(fs.readFileSync(OAUTH_PATH, 'utf8'));
        const keys = keysContent.installed || keysContent.web;
        
        if (!keys) {
            console.error('Error: Invalid OAuth keys file format. File should contain either "installed" or "web" credentials.');
            process.exit(1);
        }

        oauth2Client = new OAuth2Client(
            keys.client_id,
            keys.client_secret,
            'http://localhost:3000/oauth2callback'
        );

        if (fs.existsSync(CREDENTIALS_PATH)) {
            const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
            oauth2Client.setCredentials(credentials);
        }
    } catch (error) {
        console.error('Error loading credentials:', error);
        process.exit(1);
    }
}

async function getUserProfile() {
    try {
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const response = await gmail.users.getProfile({
            userId: 'me'
        });
        
        // Get full profile info including name
        const peopleService = google.people({ version: 'v1', auth: oauth2Client });
        const profileResponse = await peopleService.people.get({
            resourceName: 'people/me',
            personFields: 'names,emailAddresses'
        });

        const name = profileResponse.data.names?.[0]?.displayName || 'User';
        const email = response.data.emailAddress || '';
        
        return { name, email };
    } catch (error) {
        console.error('Error fetching user profile:', error);
        return null;
    }
}

async function authenticate() {
    const server = http.createServer();
    server.listen(3000);

    return new Promise<void>((resolve, reject) => {
        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: [
                'https://www.googleapis.com/auth/gmail.modify',
                'https://www.googleapis.com/auth/gmail.readonly',
                'https://www.googleapis.com/auth/gmail.metadata',
                'https://www.googleapis.com/auth/gmail.send',
                'https://www.googleapis.com/auth/gmail.compose',
                'https://www.googleapis.com/auth/gmail.labels',
                'https://www.googleapis.com/auth/userinfo.profile'
            ],
        });

        console.log('Please visit this URL to authenticate:', authUrl);
        open(authUrl);

        server.on('request', async (req, res) => {
            if (!req.url?.startsWith('/oauth2callback')) return;

            const url = new URL(req.url, 'http://localhost:3000');
            const code = url.searchParams.get('code');

            if (!code) {
                res.writeHead(400);
                res.end('No code provided');
                reject(new Error('No code provided'));
                return;
            }

            try {
                const { tokens } = await oauth2Client.getToken(code);
                oauth2Client.setCredentials(tokens);
                fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(tokens));

                res.writeHead(200);
                res.end('Authentication successful! You can close this window.');
                server.close();
                resolve();
            } catch (error) {
                res.writeHead(500);
                res.end('Authentication failed');
                reject(error);
            }
        });
    });
}

// Schema definitions
const SendEmailSchema = z.object({
    to: z.array(z.string()).describe("List of recipient email addresses"),
    subject: z.string().describe("Email subject"),
    body: z.string().describe("Email body content - Do not include a signature as it will be automatically appended using the authenticated user's name"),
    cc: z.array(z.string()).optional().describe("List of CC recipients"),
    bcc: z.array(z.string()).optional().describe("List of BCC recipients"),
});

const ReadEmailSchema = z.object({
    messageId: z.string().describe("ID of the email message to retrieve"),
});

const SearchEmailsSchema = z.object({
    query: z.string().describe("Gmail search query (e.g., 'from:example@gmail.com')"),
    maxResults: z.number().optional().describe("Maximum number of results to return"),
});

const ModifyEmailSchema = z.object({
    messageId: z.string().describe("ID of the email message to modify"),
    labelIds: z.array(z.string()).describe("List of label IDs to apply"),
});

const DeleteEmailSchema = z.object({
    messageId: z.string().describe("ID of the email message to delete"),
});

const SaveSentEmailsSchema = z.object({
    maxResults: z.number().optional().describe("Maximum number of sent emails to save (default: 50)"),
    outputDir: z.string().optional().describe("Directory to save emails to (default: './sent-emails')"),
});

// Export the save sent emails function for testing
export async function saveSentEmails(oauth2Client: OAuth2Client, maxResults: number = 50, outputDir?: string) {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const targetDir = outputDir || process.env.GMAIL_SENT_EMAILS_DIR || DEFAULT_SENT_EMAILS_DIR;
    
    // Create output directory if it doesn't exist
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    // Get list of sent messages
    const listResponse = await gmail.users.messages.list({
        userId: 'me',
        maxResults: maxResults,
        labelIds: ['SENT']
    });

    if (!listResponse.data.messages || listResponse.data.messages.length === 0) {
        return {
            savedEmails: [],
            outputDir: targetDir,
            message: "No sent messages found"
        };
    }

    const savedEmails = [];

    // Process each message
    for (const message of listResponse.data.messages) {
        const messageResponse = await gmail.users.messages.get({
            userId: 'me',
            id: message.id!,
            format: 'metadata',
            metadataHeaders: ['Subject', 'To', 'Date', 'Content-Type']
        });

        const headers = messageResponse.data.payload?.headers || [];
        const subject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value || 'No Subject';
        const to = headers.find(h => h.name?.toLowerCase() === 'to')?.value || 'No Recipient';
        const date = headers.find(h => h.name?.toLowerCase() === 'date')?.value || new Date().toISOString();

        // Extract body content
        let body = '';
        const payload = messageResponse.data.payload!;
        
        if (payload.body?.data) {
            body = Buffer.from(payload.body.data, 'base64').toString('utf8');
        } else if (payload.parts) {
            // Find the text/plain part
            const textPart = payload.parts.find(part => part.mimeType === 'text/plain');
            if (textPart?.body?.data) {
                body = Buffer.from(textPart.body.data, 'base64').toString('utf8');
            }
        }

        // Create markdown content
        const markdown = `---
Subject: ${subject}
To: ${to}
Date: ${date}
---

${body}`;

        // Create safe filename from subject and date
        const timestamp = new Date(date).getTime();
        const safeSubject = subject
            .replace(/[^a-zA-Z0-9]/g, '-')
            .replace(/-+/g, '-')
            .substring(0, 50);
        const filename = `${timestamp}-${safeSubject}.md`;
        const filepath = path.join(targetDir, filename);

        // Save to file
        fs.writeFileSync(filepath, markdown, 'utf8');
        savedEmails.push(filename);
    }

    return {
        savedEmails,
        outputDir: targetDir,
        message: `Successfully saved ${savedEmails.length} emails to ${targetDir}`
    };
}

// Main function
async function main() {
    await loadCredentials();

    if (process.argv[2] === 'auth') {
        await authenticate();
        console.log('Authentication completed successfully');
        process.exit(0);
    }

    // Initialize Gmail API and get user profile
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    userProfile = await getUserProfile();

    // Server implementation
    const server = new Server({
        name: "gmail",
        version: "1.0.0",
        capabilities: {
            tools: {},
        },
    });

    // Tool handlers
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "send_email",
                description: "Sends a new email",
                inputSchema: zodToJsonSchema(SendEmailSchema),
            },
            {
                name: "read_email",
                description: "Retrieves the content of a specific email",
                inputSchema: zodToJsonSchema(ReadEmailSchema),
            },
            {
                name: "search_emails",
                description: "Searches for emails using Gmail search syntax",
                inputSchema: zodToJsonSchema(SearchEmailsSchema),
            },
            {
                name: "modify_email",
                description: "Modifies email labels (move to different folders)",
                inputSchema: zodToJsonSchema(ModifyEmailSchema),
            },
            {
                name: "delete_email",
                description: "Permanently deletes an email",
                inputSchema: zodToJsonSchema(DeleteEmailSchema),
            },
            {
                name: "save_sent_emails",
                description: "Saves sent emails as markdown files",
                inputSchema: zodToJsonSchema(SaveSentEmailsSchema),
            },
        ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        try {
            switch (name) {
                case "send_email": {
                    const validatedArgs = SendEmailSchema.parse(args);
                    // Remove any potential "[Your name]" placeholder if it exists
                    const cleanBody = validatedArgs.body.replace(/Best regards,\s*\[Your name\]\s*$/, '').trim();
                    
                    // Generate signature if template is not empty and we have user profile
                    let signature = '';
                    if (SIGNATURE_TEMPLATE && userProfile) {
                        signature = SIGNATURE_TEMPLATE.replace('{name}', userProfile.name)
                                                   .replace('{email}', userProfile.email);
                    }

                    const message = [
                        'From: me',
                        `To: ${validatedArgs.to.join(', ')}`,
                        validatedArgs.cc ? `Cc: ${validatedArgs.cc.join(', ')}` : '',
                        validatedArgs.bcc ? `Bcc: ${validatedArgs.bcc.join(', ')}` : '',
                        `Subject: ${validatedArgs.subject}`,
                        '',
                        cleanBody + signature
                    ].filter(Boolean).join('\r\n');

                    const encodedMessage = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

                    const response = await gmail.users.messages.send({
                        userId: 'me',
                        requestBody: {
                            raw: encodedMessage,
                        },
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Email sent successfully with ID: ${response.data.id}`,
                            },
                        ],
                    };
                }

                case "read_email": {
                    const validatedArgs = ReadEmailSchema.parse(args);
                    const response = await gmail.users.messages.get({
                        userId: 'me',
                        id: validatedArgs.messageId,
                        format: 'full',
                    });

                    const headers = response.data.payload?.headers || [];
                    const subject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value || '';
                    const from = headers.find(h => h.name?.toLowerCase() === 'from')?.value || '';
                    const to = headers.find(h => h.name?.toLowerCase() === 'to')?.value || '';
                    const date = headers.find(h => h.name?.toLowerCase() === 'date')?.value || '';

                    let body = '';
                    if (response.data.payload?.body?.data) {
                        body = Buffer.from(response.data.payload.body.data, 'base64').toString('utf8');
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Subject: ${subject}\nFrom: ${from}\nTo: ${to}\nDate: ${date}\n\n${body}`,
                            },
                        ],
                    };
                }

                case "search_emails": {
                    const validatedArgs = SearchEmailsSchema.parse(args);
                    const response = await gmail.users.messages.list({
                        userId: 'me',
                        q: validatedArgs.query,
                        maxResults: validatedArgs.maxResults || 10,
                    });

                    const messages = response.data.messages || [];
                    const results = await Promise.all(
                        messages.map(async (msg) => {
                            const detail = await gmail.users.messages.get({
                                userId: 'me',
                                id: msg.id!,
                                format: 'metadata',
                                metadataHeaders: ['Subject', 'From', 'Date'],
                            });
                            const headers = detail.data.payload?.headers || [];
                            return {
                                id: msg.id,
                                subject: headers.find(h => h.name === 'Subject')?.value || '',
                                from: headers.find(h => h.name === 'From')?.value || '',
                                date: headers.find(h => h.name === 'Date')?.value || '',
                            };
                        })
                    );

                    return {
                        content: [
                            {
                                type: "text",
                                text: results.map(r => 
                                    `ID: ${r.id}\nSubject: ${r.subject}\nFrom: ${r.from}\nDate: ${r.date}\n`
                                ).join('\n'),
                            },
                        ],
                    };
                }

                case "modify_email": {
                    const validatedArgs = ModifyEmailSchema.parse(args);
                    await gmail.users.messages.modify({
                        userId: 'me',
                        id: validatedArgs.messageId,
                        requestBody: {
                            addLabelIds: validatedArgs.labelIds,
                        },
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Email ${validatedArgs.messageId} labels updated successfully`,
                            },
                        ],
                    };
                }

                case "delete_email": {
                    const validatedArgs = DeleteEmailSchema.parse(args);
                    await gmail.users.messages.delete({
                        userId: 'me',
                        id: validatedArgs.messageId,
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Email ${validatedArgs.messageId} deleted successfully`,
                            },
                        ],
                    };
                }

                case "save_sent_emails": {
                    const validatedArgs = SaveSentEmailsSchema.parse(args);
                    const result = await saveSentEmails(
                        oauth2Client,
                        validatedArgs.maxResults,
                        validatedArgs.outputDir
                    );

                    return {
                        content: [
                            {
                                type: "text",
                                text: result.message + (result.savedEmails.length > 0 ? ':\n' + result.savedEmails.join('\n') : ''),
                            },
                        ],
                    };
                }

                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        } catch (error: any) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error: ${error.message}`,
                    },
                ],
            };
        }
    });

    const transport = new StdioServerTransport();
    server.connect(transport);
}

main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
});