const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const Canvas = require('@napi-rs/canvas');
const fetch = require('node-fetch');

// Cache for profile icons
const iconCache = new Map();
const ICON_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function loadImageWithCache(url) {
    const cached = iconCache.get(url);
    if (cached && (Date.now() - cached.timestamp < ICON_CACHE_TTL)) {
        return cached.image;
    }
    
    try {
        const image = await Canvas.loadImage(url);
        iconCache.set(url, { image, timestamp: Date.now() });
        return image;
    } catch (error) {
        console.error(`Failed to load image ${url}:`, error.message);
        return null;
    }
}

// Rank tier values for LP calculation
const RANK_TIERS = {
    'IRON': { base: 0, divisions: { 'IV': 0, 'III': 100, 'II': 200, 'I': 300 } },
    'BRONZE': { base: 400, divisions: { 'IV': 0, 'III': 100, 'II': 200, 'I': 300 } },
    'SILVER': { base: 800, divisions: { 'IV': 0, 'III': 100, 'II': 200, 'I': 300 } },
    'GOLD': { base: 1200, divisions: { 'IV': 0, 'III': 100, 'II': 200, 'I': 300 } },
    'PLATINUM': { base: 1600, divisions: { 'IV': 0, 'III': 100, 'II': 200, 'I': 300 } },
    'EMERALD': { base: 2000, divisions: { 'IV': 0, 'III': 100, 'II': 200, 'I': 300 } },
    'DIAMOND': { base: 2400, divisions: { 'IV': 0, 'III': 100, 'II': 200, 'I': 300 } },
    'MASTER': { base: 2800, divisions: { 'I': 0 } },
    'GRANDMASTER': { base: 2900, divisions: { 'I': 0 } },
    'CHALLENGER': { base: 3000, divisions: { 'I': 0 } }
};

function calculateTotalLP(tier, rank, lp) {
    const tierData = RANK_TIERS[tier];
    if (!tierData) return 0;
    
    const divisionLP = tierData.divisions[rank] || 0;
    return tierData.base + divisionLP + lp;
}

function getTierFromTotalLP(totalLP) {
    for (const [tier, data] of Object.entries(RANK_TIERS).reverse()) {
        if (totalLP >= data.base) {
            const lpInTier = totalLP - data.base;
            const divisions = Object.entries(data.divisions).reverse();
            
            for (const [division, divLP] of divisions) {
                if (lpInTier >= divLP) {
                    const lp = lpInTier - divLP;
                    return { tier, rank: division, lp: Math.min(lp, 99) };
                }
            }
        }
    }
    return { tier: 'IRON', rank: 'IV', lp: 0 };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('tft-climb')
        .setDescription('Visualize your TFT Double Up ranked climb with your duo partner')
        .addStringOption(option =>
            option.setName('riotid')
                .setDescription('Riot ID (e.g., Kuromi#NA1)')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('matches')
                .setDescription('Number of matches to analyze (10-100)')
                .setMinValue(10)
                .setMaxValue(100)
                .setRequired(false)),

    async execute(interaction) {
        await interaction.deferReply();

        const riotId = interaction.options.getString('riotid');
        const matchCount = interaction.options.getInteger('matches') || 50;
        const apiKey = process.env.RIOT_API_KEY;

        try {
            // Parse Riot ID
            const [gameName, tagLine] = riotId.split('#');
            if (!gameName || !tagLine) {
                await interaction.editReply('❌ Invalid Riot ID format. Use: Name#TAG (e.g., Doublelift#NA1)');
                return;
            }

            // Fetch account
            const accountRes = await fetch(
                `https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}?api_key=${apiKey}`
            );
            
            if (!accountRes.ok) {
                await interaction.editReply('❌ Riot ID not found.');
                return;
            }
            
            const account = await accountRes.json();

            // Fetch summoner
            const summonerRes = await fetch(
                `https://na1.api.riotgames.com/tft/summoner/v1/summoners/by-puuid/${account.puuid}?api_key=${apiKey}`
            );
            
            if (!summonerRes.ok) {
                await interaction.editReply('❌ Summoner not found.');
                return;
            }
            
            const summoner = await summonerRes.json();
            summoner.gameName = account.gameName;
            summoner.tagLine = account.tagLine;

            // Fetch current ranked stats using by-puuid endpoint (returns all queues)
            const rankedRes = await fetch(
                `https://na1.api.riotgames.com/tft/league/v1/by-puuid/${account.puuid}?api_key=${apiKey}`
            );
            
            if (!rankedRes.ok) {
                await interaction.editReply('❌ Could not fetch ranked data.');
                return;
            }
            
            const rankedStats = await rankedRes.json();
            
            // Find Double Up ranked queue
            // The API returns different queueType values, could be "RANKED_TFT_PAIRS" or similar
            // We'll check if any ranked data exists and let the match history determine if they have Double Up games
            let currentRank = rankedStats.find(queue => 
                queue.queueType && queue.queueType.includes('PAIRS')
            );
            
            // If no Double Up rank found, we'll try to estimate from match history
            if (!currentRank && rankedStats.length > 0) {
                // Use any available ranked data as fallback
                currentRank = rankedStats[0];
            }
            
            if (!currentRank) {
                await interaction.editReply('❌ No ranked data found for this summoner.');
                return;
            }

            // Fetch match IDs
            const matchesRes = await fetch(
                `https://americas.api.riotgames.com/tft/match/v1/matches/by-puuid/${summoner.puuid}/ids?count=${matchCount}&api_key=${apiKey}`
            );
            const matchIds = await matchesRes.json();

            if (!matchIds || matchIds.length === 0) {
                await interaction.editReply('❌ No recent matches found.');
                return;
            }

            // Analyze matches and track LP changes
            const climbData = [];
            const duoPartners = new Map();
            let currentLP = calculateTotalLP(currentRank.tier, currentRank.rank, currentRank.leaguePoints);
            
            // Start from current and work backwards
            climbData.unshift({
                gameNumber: 0,
                totalLP: currentLP,
                tier: currentRank.tier,
                rank: currentRank.rank,
                lp: currentRank.leaguePoints,
                placement: null,
                partner: null
            });

            let doubleUpCount = 0;
            let processedGames = 0;

            for (let i = 0; i < matchIds.length; i++) {
                const matchId = matchIds[i];
                
                try {
                    const matchRes = await fetch(
                        `https://americas.api.riotgames.com/tft/match/v1/matches/${matchId}?api_key=${apiKey}`
                    );
                    
                    if (!matchRes.ok) continue;
                    
                    const match = await matchRes.json();
                    
                    // Only process Double Up games
                    if (match.info.tft_game_type !== 'pairs') continue;
                    
                    const playerData = match.info.participants.find(p => p.puuid === summoner.puuid);
                    if (!playerData) continue;

                    doubleUpCount++;
                    processedGames++;

                    // Find duo partner (same placement in Double Up)
                    const partner = match.info.participants.find(
                        p => p.puuid !== summoner.puuid && p.placement === playerData.placement
                    );

                    if (partner) {
                        const partnerKey = partner.puuid;
                        if (!duoPartners.has(partnerKey)) {
                            // Fetch partner account info
                            try {
                                const partnerSummonerRes = await fetch(
                                    `https://na1.api.riotgames.com/tft/summoner/v1/summoners/by-puuid/${partner.puuid}?api_key=${apiKey}`
                                );
                                if (partnerSummonerRes.ok) {
                                    const partnerSummoner = await partnerSummonerRes.json();
                                    
                                    const partnerAccountRes = await fetch(
                                        `https://americas.api.riotgames.com/riot/account/v1/accounts/by-puuid/${partner.puuid}?api_key=${apiKey}`
                                    );
                                    if (partnerAccountRes.ok) {
                                        const partnerAccount = await partnerAccountRes.json();
                                        duoPartners.set(partnerKey, {
                                            name: `${partnerAccount.gameName}#${partnerAccount.tagLine}`,
                                            iconId: partnerSummoner.profileIconId,
                                            count: 0
                                        });
                                    }
                                }
                            } catch (e) {
                                console.error('Failed to fetch partner info:', e);
                            }
                        }
                        
                        if (duoPartners.has(partnerKey)) {
                            duoPartners.get(partnerKey).count++;
                        }
                    }

                    // Estimate LP change based on placement (Double Up uses team placement)
                    const teamPlacement = Math.ceil(playerData.placement / 2);
                    let lpChange = 0;
                    
                    if (teamPlacement === 1) lpChange = -35;
                    else if (teamPlacement === 2) lpChange = -25;
                    else if (teamPlacement === 3) lpChange = -15;
                    else if (teamPlacement === 4) lpChange = -10;
                    else if (teamPlacement === 5) lpChange = 10;
                    else if (teamPlacement === 6) lpChange = 15;
                    else if (teamPlacement === 7) lpChange = 25;
                    else if (teamPlacement === 8) lpChange = 35;

                    // Calculate previous LP
                    const previousLP = currentLP - lpChange;
                    const rankInfo = getTierFromTotalLP(previousLP);

                    climbData.unshift({
                        gameNumber: processedGames,
                        totalLP: previousLP,
                        tier: rankInfo.tier,
                        rank: rankInfo.rank,
                        lp: rankInfo.lp,
                        placement: teamPlacement,
                        lpChange: lpChange,
                        partner: partner ? partner.puuid : null,
                        timestamp: match.info.game_datetime
                    });

                    currentLP = previousLP;

                    // Small delay to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 50));

                } catch (error) {
                    console.error(`Error processing match ${matchId}:`, error);
                    continue;
                }
            }

            if (doubleUpCount === 0) {
                await interaction.editReply('❌ No Double Up matches found in recent history.');
                return;
            }

            // Reverse to show chronological order
            climbData.reverse();
            for (let i = 0; i < climbData.length; i++) {
                climbData[i].gameNumber = i;
            }

            // Generate graph
            const canvas = await generateClimbGraph(climbData, summoner, duoPartners);
            const attachment = new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'climb.png' });

            // Calculate statistics
            const startLP = climbData[0].totalLP;
            const endLP = climbData[climbData.length - 1].totalLP;
            const totalLPGain = endLP - startLP;
            const avgLPPerGame = (totalLPGain / (climbData.length - 1)).toFixed(1);

            const wins = climbData.filter(d => d.placement && d.placement <= 2).length;
            const losses = climbData.filter(d => d.placement && d.placement >= 5).length;
            const winRate = climbData.length > 1 ? ((wins / (climbData.length - 1)) * 100).toFixed(1) : '0.0';

            // Get top duo partners
            const topPartners = Array.from(duoPartners.entries())
                .sort((a, b) => b[1].count - a[1].count)
                .slice(0, 3)
                .map(([_, data]) => `${data.name} (${data.count} games)`)
                .join('\n') || 'None';

            const startRankDisplay = `${climbData[0].tier} ${climbData[0].rank} - ${climbData[0].lp} LP`;
            const endRankDisplay = `${currentRank.tier} ${currentRank.rank} - ${currentRank.leaguePoints} LP`;

            const embed = new EmbedBuilder()
                .setColor(totalLPGain >= 0 ? '#00FF00' : '#FF0000')
                .setAuthor({ 
                    name: `${summoner.gameName}#${summoner.tagLine}`,
                    iconURL: `http://ddragon.leagueoflegends.com/cdn/15.24.1/img/profileicon/${summoner.profileIconId}.png`
                })
                .setTitle(`📈 Double Up Ranked Climb - Last ${doubleUpCount} Games`)
                .setDescription(
                    `**Starting Rank:** ${startRankDisplay}\n` +
                    `**Current Rank:** ${endRankDisplay}\n` +
                    `**Net LP Change:** ${totalLPGain >= 0 ? '+' : ''}${totalLPGain} LP`
                )
                .addFields(
                    { 
                        name: '📊 Statistics', 
                        value: `Wins: ${wins}\nLosses: ${losses}\nWin Rate: ${winRate}%\nAvg LP/Game: ${avgLPPerGame >= 0 ? '+' : ''}${avgLPPerGame}`,
                        inline: true 
                    },
                    { 
                        name: '👥 Top Duo Partners', 
                        value: topPartners,
                        inline: true 
                    }
                )
                .setImage('attachment://climb.png')
                .setTimestamp()
                .setFooter({ text: `Analyzing ${doubleUpCount} Double Up matches` });

            await interaction.editReply({ embeds: [embed], files: [attachment] });

        } catch (error) {
            console.error('Error in tft-climb command:', error);
            await interaction.editReply('❌ An error occurred while generating the climb visualization.');
        }
    }
};

async function generateClimbGraph(climbData, summoner, duoPartners) {
    const width = 1400;
    const height = 800;
    const canvas = Canvas.createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Background
    const bg = await loadImageWithCache('https://i.imgur.com/aRoCXLa.png');
    if (bg) {
        ctx.drawImage(bg, 0, 0, width, height);
        // Add semi-transparent overlay for readability
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(0, 0, width, height);
    } else {
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, width, height);
    }

    // Graph area
    const padding = { top: 80, right: 150, bottom: 100, left: 100 };
    const graphWidth = width - padding.left - padding.right;
    const graphHeight = height - padding.top - padding.bottom;

    // Calculate min/max LP for scaling
    const lpValues = climbData.map(d => d.totalLP);
    const minLP = Math.min(...lpValues);
    const maxLP = Math.max(...lpValues);
    const lpRange = maxLP - minLP || 100;

    // Draw grid lines and labels
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#ffffff';
    ctx.font = '14px Arial';
    ctx.textAlign = 'right';

    const gridLines = 8;
    for (let i = 0; i <= gridLines; i++) {
        const y = padding.top + (graphHeight / gridLines) * i;
        const lpValue = maxLP - (lpRange / gridLines) * i;
        const rankInfo = getTierFromTotalLP(lpValue);
        
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(padding.left + graphWidth, y);
        ctx.stroke();

        ctx.fillText(`${rankInfo.tier.slice(0, 3)} ${rankInfo.rank}`, padding.left - 10, y + 5);
    }

    // Draw x-axis (game numbers)
    ctx.textAlign = 'center';
    const xAxisPoints = Math.min(10, climbData.length);
    for (let i = 0; i < xAxisPoints; i++) {
        const x = padding.left + (graphWidth / (xAxisPoints - 1)) * i;
        const gameNum = Math.round((climbData.length - 1) / (xAxisPoints - 1) * i);
        ctx.fillText(`Game ${gameNum + 1}`, x, height - padding.bottom + 30);
    }

    // Draw LP line
    ctx.beginPath();
    ctx.strokeStyle = '#00D4FF';
    ctx.lineWidth = 3;

    for (let i = 0; i < climbData.length; i++) {
        const x = padding.left + (graphWidth / (climbData.length - 1)) * i;
        const y = padding.top + graphHeight - ((climbData[i].totalLP - minLP) / lpRange) * graphHeight;

        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    }
    ctx.stroke();

    // Draw data points with placement colors
    for (let i = 0; i < climbData.length; i++) {
        const data = climbData[i];
        const x = padding.left + (graphWidth / (climbData.length - 1)) * i;
        const y = padding.top + graphHeight - ((data.totalLP - minLP) / lpRange) * graphHeight;

        // Color based on placement
        if (data.placement) {
            if (data.placement <= 2) ctx.fillStyle = '#00FF00'; // Win (top 2)
            else if (data.placement <= 4) ctx.fillStyle = '#FFFF00'; // Middle
            else ctx.fillStyle = '#FF0000'; // Loss (bottom 4)
        } else {
            ctx.fillStyle = '#00D4FF'; // Current point
        }

        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();

        // Draw partner icon at intervals
        if (data.partner && duoPartners.has(data.partner) && i % 5 === 0) {
            const partner = duoPartners.get(data.partner);
            const iconUrl = `http://ddragon.leagueoflegends.com/cdn/15.24.1/img/profileicon/${partner.iconId}.png`;
            const icon = await loadImageWithCache(iconUrl);
            
            if (icon) {
                ctx.save();
                ctx.beginPath();
                ctx.arc(x, y - 25, 12, 0, Math.PI * 2);
                ctx.closePath();
                ctx.clip();
                ctx.drawImage(icon, x - 12, y - 37, 24, 24);
                ctx.restore();

                // Border around icon
                ctx.strokeStyle = '#FFD700';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(x, y - 25, 12, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
    }

    // Title
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 28px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Double Up Ranked Climb', width / 2, 40);

    // Legend
    ctx.font = '16px Arial';
    ctx.textAlign = 'left';
    const legendX = width - padding.right + 20;
    let legendY = padding.top;

    ctx.fillStyle = '#ffffff';
    ctx.fillText('Placement:', legendX, legendY);
    legendY += 30;

    // Win indicator
    ctx.fillStyle = '#00FF00';
    ctx.beginPath();
    ctx.arc(legendX + 10, legendY, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText('1st-2nd (Top 2)', legendX + 25, legendY + 5);
    legendY += 30;

    // Middle indicator
    ctx.fillStyle = '#FFFF00';
    ctx.beginPath();
    ctx.arc(legendX + 10, legendY, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText('3rd-4th', legendX + 25, legendY + 5);
    legendY += 30;

    // Loss indicator
    ctx.fillStyle = '#FF0000';
    ctx.beginPath();
    ctx.arc(legendX + 10, legendY, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText('5th-8th (Bottom 4)', legendX + 25, legendY + 5);
    legendY += 50;

    // Partner indicator
    ctx.fillStyle = '#ffffff';
    ctx.fillText('👥 = Duo Partner', legendX, legendY);

    // Display LP gain/loss trend
    const startLP = climbData[0].totalLP;
    const endLP = climbData[climbData.length - 1].totalLP;
    const change = endLP - startLP;
    
    ctx.font = 'bold 20px Arial';
    ctx.textAlign = 'center';
    ctx.fillStyle = change >= 0 ? '#00FF00' : '#FF0000';
    ctx.fillText(
        `${change >= 0 ? '▲' : '▼'} ${Math.abs(change)} LP`,
        width / 2,
        height - 30
    );

    return canvas;
}