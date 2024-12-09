import express from 'express';
import bodyParser from 'body-parser';
import session from 'express-session';
import axios from 'axios';
import dotenv from 'dotenv';
import { promises as fs } from 'fs';
import { createReadStream, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import pkg from 'twilio';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
dotenv.config();

const { twiml: { VoiceResponse } } = pkg;

// Environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVEN_LABS_API_KEY = process.env.ELEVEN_LABS_API_KEY;
const MANAGER_PHONE = process.env.MANAGER_PHONE;

// Server setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(session({
    secret: 'supersecretkey',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 30 * 60 * 1000 },
}));

// Booking function schema for GPT
const bookingFunctionSchema = {
    name: "collectBookingInformation",
    description: "Collect booking information for temple puja services",
    parameters: {
        type: "object",
        properties: {
            name: {
                type: "string",
                description: "The name of the person making the booking"
            },
            email: {
                type: "string",
                description: "Email address for booking confirmation"
            },
            phone: {
                type: "string",
                description: "Phone number of the person making the booking"
            },
            pujaName: {
                type: "string",
                description: "Name of the puja being booked"
            }
        }
    }
};

// Conversation template
const conversationHistoryTemplate = [
    {
        role: 'system',
        content: 'You are Neela, a friendly and knowledgeable phone call assistant from the Albany Hindu Temple in Albany, NY. ' +
                'Provide concise and helpful responses that are no longer than 2 lines. ' +
                'For puja bookings, collect name, email, phone, and puja name. ' +
                'If you cannot answer a question or if the user asks for a manager, respond with "TRANSFER_TO_MANAGER".'
    },
    {
        role: 'assistant',
        content: "Hello, I'm Neela from Albany Hindu Temple. How can I assist you today?"
    }
];

// Database functions
async function createBooking(bookingData) {
    try {
        const booking = await prisma.aI_Booking.create({
            data: {
                name: bookingData.name,
                email: bookingData.email,
                phone: bookingData.phone,
                pujaName: bookingData.pujaName,
            },
        });
        console.log(`New booking created - Puja: ${bookingData.pujaName}, Customer: ${bookingData.name}`);
        return booking;
    } catch (error) {
        console.error(`Failed to create booking for ${bookingData.name} - Error: ${error.message}`);
        throw error;
    }
}

// Text to Speech function
async function textToSpeech(text, sessionId) {
    try {
        const response = await axios.post(
            'https://api.elevenlabs.io/v1/text-to-speech/cgSgspJ2msm6clMCkdW9',
            {
                text: text,
                model_id: 'eleven_turbo_v2_5',
                voice_settings: { stability: 0.5, similarity_boost: 0.75 },
            },
            {
                headers: {
                    'xi-api-key': ELEVEN_LABS_API_KEY,
                    Accept: 'audio/mpeg',
                    'Content-Type': 'application/json',
                },
                responseType: 'arraybuffer',
            }
        );

        const audioPath = join(__dirname, 'audio', `${sessionId}.mp3`);
        writeFileSync(audioPath, response.data);
        return audioPath;
    } catch (error) {
        console.error(`Text-to-speech conversion failed for session ${sessionId} - Error: ${error.message}`);
        return null;
    }
}

// Generate GPT response
async function generateResponse(userInput, conversationHistory, bookingInfo = {}) {
    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-4',
                messages: conversationHistory,
                functions: [bookingFunctionSchema],
                function_call: "auto",
                max_tokens: 150,
                temperature: 0.7,
            },
            {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        const responseMessage = response.data.choices[0].message;

        if (responseMessage.function_call) {
            const functionArgs = JSON.parse(responseMessage.function_call.arguments);
            const updatedBookingInfo = { ...bookingInfo, ...functionArgs };
            
            // Check if we have all required booking information
            if (updatedBookingInfo.name && 
                updatedBookingInfo.email && 
                updatedBookingInfo.phone && 
                updatedBookingInfo.pujaName) {
                
                await createBooking(updatedBookingInfo);
                return {
                    response: "Perfect! I've recorded your booking for the puja. You'll receive a confirmation email shortly. Is there anything else you need help with?",
                    bookingInfo: null // Reset booking info after successful booking
                };
            }

            // Ask for missing information
            const missingFields = [];
            if (!updatedBookingInfo.name) missingFields.push("your name");
            if (!updatedBookingInfo.email) missingFields.push("your email address");
            if (!updatedBookingInfo.phone) missingFields.push("your phone number");
            if (!updatedBookingInfo.pujaName) missingFields.push("which puja you'd like to book");

            const response = missingFields.length === 1
                ? `Could you please provide ${missingFields[0]}?`
                : `I'll help you with the booking. Could you please provide ${missingFields.join(", ")}?`;

            return {
                response,
                bookingInfo: updatedBookingInfo
            };
        }

        return {
            response: responseMessage.content,
            bookingInfo
        };

    } catch (error) {
        console.error(`GPT response generation failed - Error: ${error.message}`);
        return {
            response: "TRANSFER_TO_MANAGER",
            bookingInfo
        };
    }
}

// Cleanup function
async function cleanupAudioFile(sessionId) {
    const audioPath = join(__dirname, 'audio', `${sessionId}.mp3`);
    try {
        if (existsSync(audioPath)) {
            unlinkSync(audioPath);
            console.log(`Audio file cleaned up for session ${sessionId}`);
        }
    } catch (error) {
        console.error(`Failed to cleanup audio file for session ${sessionId} - Error: ${error.message}`);
    }
}

// Routes
app.get('/', (req, res) => {
    res.send('Welcome to the Albany Hindu Temple Call Handling System');
});

app.post('/voice', async (req, res) => {
    const twiml = new VoiceResponse();
    try {
        req.session.sessionId = uuidv4();
        req.session.conversationHistory = [...conversationHistoryTemplate];
        req.session.bookingInfo = {};

        const initialMessage = req.session.conversationHistory[1].content;
        const audioPath = await textToSpeech(initialMessage, req.session.sessionId);
        const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

        if (audioPath) {
            twiml.play(`${baseUrl}/stream_audio/${req.session.sessionId}`);
        } else {
            twiml.say(initialMessage);
        }
        twiml.redirect('/gather');
    } catch (error) {
        console.error(`Voice endpoint error for session ${req.session.sessionId} - Error: ${error.message}`);
        twiml.say('An error occurred. Please try again later.');
    }

    res.type('text/xml').send(twiml.toString());
});

app.post('/gather', (req, res) => {
    const twiml = new VoiceResponse();
    try {
        twiml.gather({
            input: 'speech',
            action: '/process_speech',
            speechTimeout: 'auto',
            language: 'en-US',
        });
    } catch (error) {
        console.error(`Gather endpoint error for session ${req.session.sessionId} - Error: ${error.message}`);
        twiml.say('An error occurred. Please try again later.');
    }
    res.type('text/xml').send(twiml.toString());
});

app.post('/process_speech', async (req, res) => {
    const twiml = new VoiceResponse();
    const userInput = req.body.SpeechResult;
    const sessionId = req.session.sessionId;

    if (!userInput) {
        twiml.say("I'm sorry, I didn't catch that. Could you please repeat?");
        twiml.redirect('/gather');
        return res.type('text/xml').send(twiml.toString());
    }

    try {
        const conversationHistory = req.session.conversationHistory || [...conversationHistoryTemplate];
        conversationHistory.push({ role: 'user', content: userInput });

        const { response, bookingInfo } = await generateResponse(
            userInput, 
            conversationHistory, 
            req.session.bookingInfo
        );

        if (response === 'TRANSFER_TO_MANAGER') {
            console.log(`Call transfer initiated for session ${sessionId}`);
            twiml.say("I'll transfer you to our manager now. Please hold.");
            const dial = twiml.dial({
                action: '/handle-dial-status',
                method: 'POST',
                timeout: 20
            });
            dial.number(MANAGER_PHONE);
        } else {
            conversationHistory.push({ role: 'assistant', content: response });
            req.session.conversationHistory = conversationHistory;
            req.session.bookingInfo = bookingInfo;

            const audioPath = await textToSpeech(response, sessionId);
            const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

            if (audioPath) {
                twiml.play(`${baseUrl}/stream_audio/${sessionId}`);
            } else {
                twiml.say(response);
            }
            twiml.redirect('/gather');
        }
    } catch (error) {
        console.error(`Speech processing error for session ${sessionId} - Error: ${error.message}`);
        twiml.say('An error occurred. Please try again later.');
        await cleanupAudioFile(sessionId);
    }

    res.type('text/xml').send(twiml.toString());
});

app.post('/handle-dial-status', async (req, res) => {
    const twiml = new VoiceResponse();
    const dialCallStatus = req.body.DialCallStatus;
    const sessionId = req.session.sessionId;

    if (dialCallStatus !== 'completed') {
        console.log(`Manager transfer failed for session ${sessionId} - Status: ${dialCallStatus}`);
        const message = "I apologize, but our manager is currently unavailable. I'll continue to assist you. What can I help you with?";
        
        try {
            req.session.conversationHistory = [...conversationHistoryTemplate];
            const audioPath = await textToSpeech(message, sessionId);
            const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

            if (audioPath) {
                twiml.play(`${baseUrl}/stream_audio/${sessionId}`);
            } else {
                twiml.say(message);
            }
            twiml.redirect('/gather');
        } catch (error) {
            console.error(`Dial status handling error for session ${sessionId} - Error: ${error.message}`);
            twiml.say('An error occurred. Please try again later.');
        }
    } else {
        console.log(`Call successfully transferred to manager for session ${sessionId}`);
        twiml.hangup();
    }

    res.type('text/xml').send(twiml.toString());
});

app.get('/stream_audio/:sessionId', (req, res) => {
    const audioPath = join(__dirname, 'audio', `${req.params.sessionId}.mp3`);
    if (existsSync(audioPath)) {
        res.setHeader('Content-Type', 'audio/mpeg');
        const stream = createReadStream(audioPath);
        stream.pipe(res);
        stream.on('end', () => {
            cleanupAudioFile(req.params.sessionId)
                .catch(error => console.error(`Audio streaming cleanup error for session ${req.params.sessionId} - Error: ${error.message}`));
        });
    } else {
        console.error(`Audio file not found for session ${req.params.sessionId}`);
        res.status(404).send('Audio file not found');
    }
});

// Create audio directory if it doesn't exist
const audioDir = join(__dirname, 'audio');
if (!existsSync(audioDir)) {
    mkdirSync(audioDir);
    console.log('Audio directory created');
}

// Start server
app.listen(port, () => {
    console.log(`Temple call handling system running on port ${port}`);
});