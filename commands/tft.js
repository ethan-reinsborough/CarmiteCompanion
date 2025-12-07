const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const Canvas = require('@napi-rs/canvas');
const fetch = require('node-fetch');

// Cache for summoner data
const summonerCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// Match data cache
const matchDataCache = new Map();
const MATCH_DATA_TTL = 30 * 60 * 1000;

// Match detail cache
const matchDetailCache = new Map();
const MATCH_DETAIL_TTL = 15 * 60 * 1000;

// Canvas image cache (champion images, stars, backgrounds)
const imageCache = new Map();
const IMAGE_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Pre-generated canvas cache
const canvasCache = new Map();
const CANVAS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

let debugMode = true;

function logDebug(...args) {
    if (debugMode) {
        console.log('[TFT DEBUG]', ...args);
    }
}

// Cleanup functions
function cleanupOldCacheEntries() {
    const now = Date.now();
    
    for (const [key, data] of matchDataCache.entries()) {
        if (now - data.timestamp > MATCH_DATA_TTL) {
            matchDataCache.delete(key);
        }
    }
    
    for (const [key, data] of matchDetailCache.entries()) {
        if (now - data.timestamp > MATCH_DETAIL_TTL) {
            matchDetailCache.delete(key);
        }
    }
    
    for (const [key, data] of canvasCache.entries()) {
        if (now - data.timestamp > CANVAS_CACHE_TTL) {
            canvasCache.delete(key);
        }
    }
    
    for (const [key, data] of imageCache.entries()) {
        if (now - data.timestamp > IMAGE_CACHE_TTL) {
            imageCache.delete(key);
        }
    }
}

setInterval(cleanupOldCacheEntries, 5 * 60 * 1000);

// Lookup tables
const TIER_STARS = {
    1: null,
    2: 'https://raw.communitydragon.org/pbe/game/assets/ux/tft/notificationicons/silverstar.png',
    3: 'https://raw.communitydragon.org/pbe/game/assets/ux/tft/notificationicons/goldstar.png'
};

const PLACEMENT_COLORS = {
    1: '#FFD700', 2: '#FFD700',
    3: '#d4d4d4', 4: '#d4d4d4',
    5: '#945e1c', 6: '#945e1c',
    7: '#000000', 8: '#000000'
};

const PLACEMENT_SUFFIX = {
    1: 'st', 2: 'nd', 3: 'rd', 4: 'th',
    5: 'th', 6: 'th', 7: 'th', 8: 'th'
};

// Optimized image loading with caching
async function loadImageWithCache(url) {
    // Check cache first
    const cached = imageCache.get(url);
    if (cached && (Date.now() - cached.timestamp < IMAGE_CACHE_TTL)) {
        return cached.image;
    }
    
    // Load from network
    try {
        logDebug(`Loading image: ${url}`);
        const image = await Canvas.loadImage(url);
        
        // Cache it
        imageCache.set(url, {
            image,
            timestamp: Date.now()
        });
        
        return image;
    } catch (error) {
        logDebug(`Failed to load image ${url}:`, error.message);
        return null;
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('tft')
        .setDescription('View TFT match history with interactive navigation')
        .addStringOption(option =>
            option.setName('riotid')
                .setDescription('Riot ID (e.g., Kuromi#NA1)')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('matches')
                .setDescription('Number of matches to load (1-20)')
                .setMinValue(1)
                .setMaxValue(20)
                .setRequired(false)),

    async execute(interaction) {
        await interaction.deferReply();

        const riotId = interaction.options.getString('riotid');
        const matchCount = interaction.options.getInteger('matches') || 5;
        const apiKey = process.env.RIOT_API_KEY;

        try {
            // Parse Riot ID
            const [gameName, tagLine] = riotId.split('#');
            if (!gameName || !tagLine) {
                await interaction.editReply('❌ Invalid Riot ID format. Use: Name#TAG (e.g., Doublelift#NA1)');
                return;
            }

            // Fetch account
            const cacheKey = riotId.toLowerCase();
            let account = summonerCache.get(cacheKey);
            
            if (!account || Date.now() - account.timestamp > CACHE_TTL) {
                const accountRes = await fetch(
                    `https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}?api_key=${apiKey}`
                );
                
                if (!accountRes.ok) {
                    await interaction.editReply('❌ Riot ID not found. Check the format: Name#TAG (e.g., Doublelift#NA1)');
                    return;
                }
                
                account = await accountRes.json();
                account.timestamp = Date.now();
                summonerCache.set(cacheKey, account);
            }

            // Fetch summoner
            const summonerRes = await fetch(
                `https://na1.api.riotgames.com/tft/summoner/v1/summoners/by-puuid/${account.puuid}?api_key=${apiKey}`
            );
            
            if (!summonerRes.ok) {
                await interaction.editReply('❌ Summoner not found for this region.');
                return;
            }
            
            const summoner = await summonerRes.json();
            
            summoner.gameName = account.gameName;
            summoner.tagLine = account.tagLine;

            // Fetch ranked stats
            const rankedRes = await fetch(
                `https://na1.api.riotgames.com/tft/league/v1/entries/by-summoner/${summoner.id}?api_key=${apiKey}`
            );
            const rankedStats = await rankedRes.json();

            const rankedDisplay = rankedStats.length > 0
                ? `${rankedStats[0].tier} ${rankedStats[0].rank} - ${rankedStats[0].leaguePoints} LP`
                : 'Unranked';

            // Fetch match IDs
            const matchesRes = await fetch(
                `https://americas.api.riotgames.com/tft/match/v1/matches/by-puuid/${summoner.puuid}/ids?count=${matchCount}&api_key=${apiKey}`
            );
            const matchIds = await matchesRes.json();

            if (!matchIds || matchIds.length === 0) {
                await interaction.editReply('❌ No matches found for this summoner.');
                return;
            }

            logDebug(`Starting pre-generation for ${matchIds.length} matches`);
            
            const allMatchDetails = {};
            const preGenerationPromises = [];
            
            // Load background image once
            const bgPromise = loadImageWithCache('https://i.imgur.com/aRoCXLa.png');
            
            // Load star images once
            const silverStarPromise = loadImageWithCache(TIER_STARS[2]);
            const goldStarPromise = loadImageWithCache(TIER_STARS[3]);
            
            // Fetch all matches
            for (const matchId of matchIds) {
                const fetchPromise = (async () => {
                    try {
                        // Check cache
                        const cached = matchDetailCache.get(matchId);
                        if (cached && (Date.now() - cached.timestamp < MATCH_DETAIL_TTL)) {
                            allMatchDetails[matchId] = cached.data;
                            return { matchId, fromCache: true };
                        }
                        
                        // Fetch from API
                        logDebug(`Fetching match ${matchId} from API`);
                        const matchRes = await fetch(
                            `https://americas.api.riotgames.com/tft/match/v1/matches/${matchId}?api_key=${apiKey}`
                        );
                        
                        if (!matchRes.ok) throw new Error(`API status: ${matchRes.status}`);
                        
                        const matchData = await matchRes.json();
                        const playerData = matchData.info.participants.find(p => p.puuid === summoner.puuid);
                        
                        if (!playerData) throw new Error('Player data not found');
                        
                        const matchDetail = { matchData, playerData };
                        matchDetailCache.set(matchId, {
                            data: matchDetail,
                            timestamp: Date.now()
                        });
                        
                        allMatchDetails[matchId] = matchDetail;
                        
                        // Pre-load champion images for this match
                        const championPromises = playerData.units.slice(0, 10).map(async (unit) => {
                            const champName = unit.character_id.toLowerCase();
                            const urls = [
                                `https://raw.communitydragon.org/pbe/game/assets/ux/tft/championsplashes/patching/${champName}_square.tft_set16.png`,
                                `https://raw.communitydragon.org/latest/game/assets/ux/tft/championsplashes/${champName}_square.tft_set16.png`
                            ];
                            
                            for (const url of urls) {
                                try {
                                    await loadImageWithCache(url);
                                    break; // Success, move to next champion
                                } catch (e) {
                                    continue;
                                }
                            }
                        });
                        
                        await Promise.allSettled(championPromises);
                        
                        return { matchId, fromCache: false };
                        
                    } catch (error) {
                        logDebug(`Failed to process match ${matchId}:`, error.message);
                        return null;
                    }
                })();
                
                preGenerationPromises.push(fetchPromise);
            }
            
            // Wait for everything
            await Promise.all([bgPromise, silverStarPromise, goldStarPromise]);
            const results = await Promise.allSettled(preGenerationPromises);
            
            const successful = results.filter(r => r.status === 'fulfilled' && r.value !== null);
            const fromCacheCount = successful.filter(r => r.value.fromCache).length;
            const fromApiCount = successful.filter(r => !r.value.fromCache).length;
            
            logDebug(`Pre-generation complete: ${fromCacheCount} from cache, ${fromApiCount} from API`);

            // Create session
            const dataKey = `tft_${interaction.user.id}_${Date.now()}`;
            const sessionData = {
                summoner,
                matchIds,
                matchDetails: allMatchDetails,
                currentIndex: 0,
                rankedDisplay,
                timestamp: Date.now(),
                apiKey
            };
            
            matchDataCache.set(dataKey, sessionData);

            // Show first match
            await showMatch(interaction, dataKey, 0);

        } catch (error) {
            console.error('Error in TFT command:', error);
            await interaction.editReply('❌ An error occurred while fetching match data. Please try again.');
        }
    },

    async handleButton(interaction) {
        logDebug('Button clicked:', interaction.customId);
        
        const customId = interaction.customId;
        const parts = customId.split('_');
        
        if (parts.length < 3) {
            await interaction.reply({ 
                content: '❌ Invalid button data.', 
                ephemeral: true 
            });
            return;
        }
        
        const action = parts.pop();
        const dataKey = parts.join('_');
        
        logDebug(`Parsed: dataKey=${dataKey}, action=${action}`);

        const sessionData = matchDataCache.get(dataKey);
        
        if (!sessionData) {
            await interaction.reply({ 
                content: '❌ Session expired. Please run /tft again.', 
                ephemeral: true 
            });
            return;
        }

        let newIndex = sessionData.currentIndex;
        if (action === 'prev') newIndex--;
        if (action === 'next') newIndex++;

        if (newIndex < 0 || newIndex >= sessionData.matchIds.length) {
            await interaction.reply({ 
                content: '❌ No more matches in that direction.', 
                ephemeral: true 
            });
            return;
        }

        sessionData.currentIndex = newIndex;
        sessionData.timestamp = Date.now();
        
        logDebug(`Navigating to match ${newIndex}`);
        
        await interaction.deferUpdate();
        await showMatch(interaction, dataKey, newIndex, true);
    }
};

async function showMatch(interaction, dataKey, index, isUpdate = false) {
    const startTime = Date.now();
    logDebug(`showMatch called: index=${index}`);
    
    const sessionData = matchDataCache.get(dataKey);
    
    if (!sessionData) {
        await interaction.editReply({ content: '❌ Session expired.', components: [] });
        return;
    }
    
    const { matchIds, matchDetails, summoner, rankedDisplay } = sessionData;
    const matchId = matchIds[index];
    
    // Check for cached canvas first
    const canvasCacheKey = `${dataKey}_${matchId}`;
    const cachedCanvas = canvasCache.get(canvasCacheKey);
    
    let canvas;
    let fromCache = false;
    
    if (cachedCanvas && (Date.now() - cachedCanvas.timestamp < CANVAS_CACHE_TTL)) {
        logDebug(`Using cached canvas for match ${index}`);
        canvas = cachedCanvas.canvas;
        fromCache = true;
    } else {
        // Generate new canvas
        const matchDetail = matchDetails[matchId];
        if (!matchDetail) {
            await interaction.editReply({ content: '❌ Match data not found.', components: [] });
            return;
        }
        
        logDebug(`Generating new canvas for match ${index}`);
        canvas = await generateMatchCanvas(matchDetail.playerData, matchDetail.matchData);
        
        // Cache the canvas for future pagination
        canvasCache.set(canvasCacheKey, {
            canvas,
            timestamp: Date.now()
        });
    }
    
    const matchDetail = matchDetails[matchId];
    const { playerData, matchData } = matchDetail;
    
    const attachment = new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'match.png' });

    // Build embed
    const matchType = matchData.info.tft_game_type === 'pairs' ? 'Double Up' : 'Ranked';
    
    let displayPlacement = playerData.placement;
    let placementText = matchType;
    if (matchType === 'Double Up') {
        displayPlacement = Math.ceil(playerData.placement / 2);
        placementText = 'Double Up';
    }
    
    // Format traits
    const traitsByTier = {
        gold: [],
        silver: [],
        bronze: []
    };
    
    playerData.traits
        .filter(t => t.tier_current > 0)
        .forEach(t => {
            const cleanName = t.name.replace(/^TFT\d+_|^Set\d+_/g, '');
            const traitStr = `${cleanName} (${t.num_units})`;
            
            if (t.tier_current === 3) traitsByTier.gold.push(traitStr);
            else if (t.tier_current === 2) traitsByTier.silver.push(traitStr);
            else traitsByTier.bronze.push(traitStr);
        });
    
    let traitsDisplay = '';
    if (traitsByTier.gold.length > 0) traitsDisplay += `🏆 ${traitsByTier.gold.join(' • ')}\n`;
    if (traitsByTier.silver.length > 0) traitsDisplay += `🥈 ${traitsByTier.silver.join(' • ')}\n`;
    if (traitsByTier.bronze.length > 0) traitsDisplay += `🥉 ${traitsByTier.bronze.join(' • ')}`;
    traitsDisplay = traitsDisplay.trim() || 'None';

    const embed = new EmbedBuilder()
        .setColor(PLACEMENT_COLORS[playerData.placement])
        .setAuthor({ 
            name: `${summoner.gameName}#${summoner.tagLine} - ${rankedDisplay}`, 
            iconURL: `https://ddragon.leagueoflegends.com/cdn/15.18.1/img/profileicon/${summoner.profileIconId}.png` 
        })
        .setTitle(`${placementText} - ${displayPlacement}${PLACEMENT_SUFFIX[displayPlacement]} Place`)
        .setDescription(
            `**Level:** ${playerData.level} | **Eliminations:** ${playerData.players_eliminated} | **Damage:** ${playerData.total_damage_to_players}\n\n` +
            `**Traits:**\n${traitsDisplay}`
        )
        .setImage('attachment://match.png')
        .setFooter({ text: `Match ${index + 1} of ${matchIds.length}` })
        .setTimestamp(matchData.info.game_datetime);

    // Navigation buttons
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`${dataKey}_prev`)
                .setLabel('◀ Previous')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(index === 0),
            new ButtonBuilder()
                .setCustomId(`${dataKey}_next`)
                .setLabel('Next ▶')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(index === matchIds.length - 1)
        );

    const payload = { embeds: [embed], files: [attachment], components: [row] };

    if (isUpdate) {
        await interaction.editReply(payload);
    } else {
        await interaction.editReply(payload);
    }
    
    const totalTime = Date.now() - startTime;
    logDebug(`Match ${index} rendered in ${totalTime}ms (canvas: ${fromCache ? 'cached' : 'generated'})`);
}

async function generateMatchCanvas(playerData, matchData) {
    const startTime = Date.now();
    const canvas = Canvas.createCanvas(700, 400);
    const ctx = canvas.getContext('2d');

    // Background (cached)
    const bg = await loadImageWithCache('https://i.imgur.com/aRoCXLa.png');
    if (bg) {
        ctx.drawImage(bg, 0, 0, 700, 400);
    } else {
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, 700, 400);
    }

    // Grid positions
    const positions = [
        [5, 105], [145, 105], [285, 105], [425, 105], [565, 105],
        [5, 255], [145, 255], [285, 255], [425, 255], [565, 255]
    ];

    const unitCount = Math.min(playerData.units.length, 10);
    
    // Pre-load all champion images for this match
    const championPromises = playerData.units.slice(0, unitCount).map(async (unit, i) => {
        const champName = unit.character_id.toLowerCase();
        const urls = [
            `https://raw.communitydragon.org/pbe/game/assets/ux/tft/championsplashes/patching/${champName}_square.tft_set16.png`
        ];
        
        let champImage = null;
        for (const url of urls) {
            champImage = await loadImageWithCache(url);
            if (champImage) break;
        }
        
        return { index: i, unit, champImage };
    });
    
    const championResults = await Promise.allSettled(championPromises);

    // Draw all champions
    for (const result of championResults) {
        if (result.status !== 'fulfilled' || !result.value) continue;
        
        const { index, unit, champImage } = result.value;
        const [x, y] = positions[index];

        // Draw unit box
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, 130, 140);

        if (champImage) {
            ctx.drawImage(champImage, x, y, 130, 140);
        } else {
            // Fallback placeholder
            ctx.fillStyle = '#2a2a2a';
            ctx.fillRect(x, y, 130, 140);
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 14px Arial';
            ctx.textAlign = 'center';
            
            const displayName = unit.character_id.replace('TFT16_', '').replace('_', ' ');
            const words = displayName.split(' ');
            if (words.length > 1) {
                ctx.fillText(words[0], x + 65, y + 60);
                ctx.fillText(words[1], x + 65, y + 80);
            } else {
                ctx.fillText(displayName.slice(0, 12), x + 65, y + 70);
            }
            
            ctx.textAlign = 'left';
        }

        // Draw stars (cached)
        if (unit.tier > 1) {
            const starUrl = TIER_STARS[unit.tier];
            if (starUrl) {
                const starImage = await loadImageWithCache(starUrl);
                if (starImage) {
                    const starCount = unit.tier;
                    const startX = x + (130 - starCount * 20) / 2;
                    
                    for (let s = 0; s < starCount; s++) {
                        ctx.drawImage(starImage, startX + s * 20, y + 115, 20, 20);
                    }
                } else {
                    // Text fallback
                    ctx.fillStyle = '#FFD700';
                    ctx.font = 'bold 16px Arial';
                    ctx.textAlign = 'center';
                    const stars = '★'.repeat(unit.tier);
                    ctx.fillText(stars, x + 65, y + 130);
                    ctx.textAlign = 'left';
                }
            }
        }
    }

    const generationTime = Date.now() - startTime;
    logDebug(`Canvas generated in ${generationTime}ms`);
    
    return canvas;
}