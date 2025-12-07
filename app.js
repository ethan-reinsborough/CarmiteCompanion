require('dotenv').config();
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
    ]
});

// Command collection
client.commands = new Collection();

// Load command files
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
    } else {
        console.log(`[WARNING] The command at ${filePath} is missing required "data" or "execute" property.`);
    }
}

// Ready event
client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}!`);
    console.log(`📊 Ready to serve ${client.guilds.cache.size} servers`);
});

// Interaction handler
client.on('interactionCreate', async interaction => {
    // Handle slash commands
    if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);

        if (!command) {
            console.error(`No command matching ${interaction.commandName} was found.`);
            return;
        }

        try {
            await command.execute(interaction);
        } catch (error) {
            console.error(`Error executing ${interaction.commandName}:`, error);
            const errorMessage = { content: '❌ There was an error executing this command!', ephemeral: true };
            
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(errorMessage);
            } else {
                await interaction.reply(errorMessage);
            }
        }
    }
    
    // Handle button interactions
    if (interaction.isButton()) {
        const command = client.commands.get(interaction.customId.split('_')[0]);
        if (command && command.handleButton) {
            try {
                await command.handleButton(interaction);
            } catch (error) {
                console.error('Error handling button:', error);
            }
        }
    }

    // Handle select menu interactions
    if (interaction.isStringSelectMenu()) {
        const command = client.commands.get(interaction.customId.split('_')[0]);
        if (command && command.handleSelectMenu) {
            try {
                await command.handleSelectMenu(interaction);
            } catch (error) {
                console.error('Error handling select menu:', error);
            }
        }
    }
});

// Error handling
client.on('error', error => {
    console.error('Discord client error:', error);
});

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

// Login
client.login(process.env.DISCORD_TOKEN);