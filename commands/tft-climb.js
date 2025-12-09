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
            const matchHistory = []; // Store all matches first
            const duoPartners = new Map();
            
            // Set 16 launch date (December 3rd, 2025)
            const set16LaunchDate = new Date('2025-12-03T00:00:00Z').getTime();

            for (let i = 0; i < matchIds.length; i++) {
                const matchId = matchIds[i];
                
                try {
                    const matchRes = await fetch(
                        `https://americas.api.riotgames.com/tft/match/v1/matches/${matchId}?api_key=${apiKey}`
                    );
                    
                    if (!matchRes.ok) continue;
                    
                    const match = await matchRes.json();
                    
                    // Skip games from before Set 16 launch (rank reset)
                    if (match.info.game_datetime < set16LaunchDate) {
                        continue;
                    }
                    
                    // Only process Double Up games
                    if (match.info.tft_game_type !== 'pairs') continue;
                    
                    const playerData = match.info.participants.find(p => p.puuid === summoner.puuid);
                    if (!playerData) continue;

                    // Find duo partner using Double Up placement logic
                    const teamPlacement = Math.ceil(playerData.placement / 2);
                    const partner = match.info.participants.find(
                        p => p.puuid !== summoner.puuid && Math.ceil(p.placement / 2) === teamPlacement
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

                    // Store match data
                    let lpChange = 0;
                    
                    if (teamPlacement === 1) lpChange = 35;
                    else if (teamPlacement === 2) lpChange = 25;
                    else if (teamPlacement === 3) lpChange = 15;
                    else if (teamPlacement === 4) lpChange = 10;
                    else if (teamPlacement === 5) lpChange = -10;
                    else if (teamPlacement === 6) lpChange = -15;
                    else if (teamPlacement === 7) lpChange = -25;
                    else if (teamPlacement === 8) lpChange = -35;

                    matchHistory.push({
                        timestamp: match.info.game_datetime,
                        teamPlacement: teamPlacement,
                        lpChange: lpChange,
                        partner: partner ? partner.puuid : null
                    });

                    // Small delay to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 50));

                } catch (error) {
                    console.error(`Error processing match ${matchId}:`, error);
                    continue;
                }
            }

            if (matchHistory.length === 0) {
                await interaction.editReply('❌ No Double Up matches found since December 3rd, 2025.');
                return;
            }

            // Sort by timestamp (oldest first)
            matchHistory.sort((a, b) => a.timestamp - b.timestamp);

            // Now build climb data going FORWARD from first game
            const climbData = [];
            const currentTotalLP = calculateTotalLP(currentRank.tier, currentRank.rank, currentRank.leaguePoints);
            
            // Calculate total LP change from all games
            const totalLPChange = matchHistory.reduce((sum, match) => sum + match.lpChange, 0);
            
            // Starting LP = Current LP - Total LP Change
            let trackingLP = currentTotalLP - totalLPChange;
            const startRankInfo = getTierFromTotalLP(trackingLP);
            
            // Add starting point
            climbData.push({
                gameNumber: 0,
                totalLP: trackingLP,
                tier: startRankInfo.tier,
                rank: startRankInfo.rank,
                lp: startRankInfo.lp,
                placement: null,
                partner: null
            });

            // Now go through each match in chronological order
            for (let i = 0; i < matchHistory.length; i++) {
                const match = matchHistory[i];
                trackingLP += match.lpChange;
                const rankInfo = getTierFromTotalLP(trackingLP);
                
                climbData.push({
                    gameNumber: i + 1,
                    totalLP: trackingLP,
                    tier: rankInfo.tier,
                    rank: rankInfo.rank,
                    lp: rankInfo.lp,
                    placement: match.teamPlacement,
                    lpChange: match.lpChange,
                    partner: match.partner,
                    timestamp: match.timestamp
                });
            }

            const doubleUpCount = matchHistory.length;

            // Generate graph
            const canvas = await generateClimbGraph(climbData, summoner, duoPartners);
            const attachment = new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'climb.png' });

            // Calculate statistics
            const startLP = climbData[0].totalLP;
            const endLP = climbData[climbData.length - 1].totalLP;
            const netLPGain = endLP - startLP;
            const avgLPPerGame = doubleUpCount > 0 ? (netLPGain / doubleUpCount).toFixed(1) : '0.0';

            // Calculate placement statistics (Double Up style)
            const firsts = matchHistory.filter(d => d.teamPlacement === 1).length;
            const seconds = matchHistory.filter(d => d.teamPlacement === 2).length;
            const thirds = matchHistory.filter(d => d.teamPlacement === 3).length;
            const fourths = matchHistory.filter(d => d.teamPlacement === 4).length;
            
            const top2Count = firsts + seconds; // Win in Double Up
            const top2Rate = doubleUpCount > 0 ? ((top2Count / doubleUpCount) * 100).toFixed(1) : '0.0';

            // Get top duo partners
            const topPartners = Array.from(duoPartners.entries())
                .sort((a, b) => b[1].count - a[1].count)
                .slice(0, 3)
                .map(([_, data]) => `${data.name} (${data.count} games)`)
                .join('\n') || 'None';

            const startRankDisplay = `${climbData[0].tier} ${climbData[0].rank} - ${climbData[0].lp} LP`;
            const endRankDisplay = `${currentRank.tier} ${currentRank.rank} - ${currentRank.leaguePoints} LP`;

            const embed = new EmbedBuilder()
                .setColor(netLPGain >= 0 ? '#00FF00' : '#FF0000')
                .setAuthor({ 
                    name: `${summoner.gameName}#${summoner.tagLine}`,
                    iconURL: `http://ddragon.leagueoflegends.com/cdn/15.24.1/img/profileicon/${summoner.profileIconId}.png`
                })
                .setTitle(`📈 Double Up Ranked Climb - Last ${doubleUpCount} Games`)
                .setDescription(
                    `**Starting Rank:** ${startRankDisplay}\n` +
                    `**Current Rank:** ${endRankDisplay}\n` +
                    `**Net LP Change:** ${netLPGain >= 0 ? '+' : ''}${netLPGain} LP`
                )
                .addFields(
                    { 
                        name: '📊 Placements', 
                        value: `1sts: ${firsts}\n2nds: ${seconds}\n3rds: ${thirds}\n4ths: ${fourths}\nTop 2 Rate: ${top2Rate}%`,
                        inline: true 
                    },
                    { 
                        name: '📈 Performance',
                        value: `Avg LP/Game: ${avgLPPerGame >= 0 ? '+' : ''}${avgLPPerGame}\nTotal Games: ${doubleUpCount}`,
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
                .setFooter({ text: `Analyzing ${doubleUpCount} Double Up matches since Dec 3, 2025` });

            await interaction.editReply({ embeds: [embed], files: [attachment] });

        } catch (error) {
            console.error('Error in tft-climb command:', error);
            await interaction.editReply('❌ An error occurred while generating the climb visualization.');
        }
    }
};

async function generateClimbGraph(climbData, summoner, duoPartners) {
    const width = 1600;
    const height = 900;
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

    // Graph area with more space for legend
    const padding = { top: 80, right: 250, bottom: 100, left: 100 };
    const graphWidth = width - padding.left - padding.right;
    const graphHeight = height - padding.top - padding.bottom;

    // Calculate min/max LP for scaling - add padding for better view
    const lpValues = climbData.map(d => d.totalLP);
    const minLP = Math.min(...lpValues);
    const maxLP = Math.max(...lpValues);
    const lpRange = maxLP - minLP || 100;
    
    // Add 10% padding to top and bottom for better visualization
    const lpPadding = lpRange * 0.1;
    const displayMinLP = minLP - lpPadding;
    const displayMaxLP = maxLP + lpPadding;
    const displayRange = displayMaxLP - displayMinLP;

    // Draw grid lines and labels
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#ffffff';
    ctx.font = '14px Arial';
    ctx.textAlign = 'right';

    const gridLines = 8;
    for (let i = 0; i <= gridLines; i++) {
        const y = padding.top + (graphHeight / gridLines) * i;
        const lpValue = displayMaxLP - (displayRange / gridLines) * i;
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
        const y = padding.top + graphHeight - ((climbData[i].totalLP - displayMinLP) / displayRange) * graphHeight;

        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    }
    ctx.stroke();

    // Draw data points with placement colors (Double Up: 1-4 instead of 1-8)
    for (let i = 0; i < climbData.length; i++) {
        const data = climbData[i];
        const x = padding.left + (graphWidth / (climbData.length - 1)) * i;
        const y = padding.top + graphHeight - ((data.totalLP - displayMinLP) / displayRange) * graphHeight;

        // Color based on Double Up placement (1-4)
        if (data.placement) {
            if (data.placement === 1) ctx.fillStyle = '#FFD700'; // 1st - Gold
            else if (data.placement === 2) ctx.fillStyle = '#00FF00'; // 2nd - Green (still top 2)
            else if (data.placement === 3) ctx.fillStyle = '#FFFF00'; // 3rd - Yellow
            else if (data.placement === 4) ctx.fillStyle = '#FF0000'; // 4th - Red
        } else {
            ctx.fillStyle = '#00D4FF'; // Current point
        }

        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();

        // Draw partner icon at intervals
        if (data.partner && duoPartners.has(data.partner) && i % 3 === 0 && i > 0) {
            const partner = duoPartners.get(data.partner);
            const iconUrl = `http://ddragon.leagueoflegends.com/cdn/15.24.1/img/profileicon/${partner.iconId}.png`;
            const icon = await loadImageWithCache(iconUrl);
            
            if (icon) {
                ctx.save();
                ctx.beginPath();
                ctx.arc(x, y - 30, 15, 0, Math.PI * 2);
                ctx.closePath();
                ctx.clip();
                ctx.drawImage(icon, x - 15, y - 45, 30, 30);
                ctx.restore();

                // Border around icon
                ctx.strokeStyle = '#FFD700';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(x, y - 30, 15, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
    }

    // Title
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Double Up Ranked Climb', width / 2, 45);

    // Legend
    ctx.font = '18px Arial';
    ctx.textAlign = 'left';
    const legendX = width - padding.right + 30;
    let legendY = padding.top;

    ctx.fillStyle = '#ffffff';
    ctx.fillText('Placement:', legendX, legendY);
    legendY += 35;

    // 1st place indicator
    ctx.fillStyle = '#FFD700';
    ctx.beginPath();
    ctx.arc(legendX + 10, legendY, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText('1st Place', legendX + 25, legendY + 5);
    legendY += 35;

    // 2nd place indicator
    ctx.fillStyle = '#00FF00';
    ctx.beginPath();
    ctx.arc(legendX + 10, legendY, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText('2nd Place', legendX + 25, legendY + 5);
    legendY += 35;

    // 3rd place indicator
    ctx.fillStyle = '#FFFF00';
    ctx.beginPath();
    ctx.arc(legendX + 10, legendY, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText('3rd Place', legendX + 25, legendY + 5);
    legendY += 35;

    // 4th place indicator
    ctx.fillStyle = '#FF0000';
    ctx.beginPath();
    ctx.arc(legendX + 10, legendY, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText('4th Place', legendX + 25, legendY + 5);
    legendY += 55;

    // Duo Partner section
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px Arial';
    ctx.fillText('Duo Partner', legendX, legendY);
    legendY += 35;

    // Draw the most common duo partner's icon (if exists)
    const topPartner = Array.from(duoPartners.entries())
        .sort((a, b) => b[1].count - a[1].count)[0];
    
    if (topPartner) {
        const [_, partnerData] = topPartner;
        const partnerIconUrl = `http://ddragon.leagueoflegends.com/cdn/15.24.1/img/profileicon/${partnerData.iconId}.png`;
        const partnerIcon = await loadImageWithCache(partnerIconUrl);
        
        if (partnerIcon) {
            const iconSize = 50;
            const iconX = legendX + 75;
            const iconY = legendY;
            
            // Gradient background circle
            const gradient = ctx.createRadialGradient(iconX, iconY, 0, iconX, iconY, iconSize / 2 + 10);
            gradient.addColorStop(0, 'rgba(255, 215, 0, 0.3)');
            gradient.addColorStop(1, 'rgba(255, 215, 0, 0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(iconX, iconY, iconSize / 2 + 10, 0, Math.PI * 2);
            ctx.fill();
            
            // Draw icon with circular clip
            ctx.save();
            ctx.beginPath();
            ctx.arc(iconX, iconY, iconSize / 2, 0, Math.PI * 2);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(partnerIcon, iconX - iconSize / 2, iconY - iconSize / 2, iconSize, iconSize);
            ctx.restore();
            
            // Gold border
            ctx.strokeStyle = '#FFD700';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(iconX, iconY, iconSize / 2, 0, Math.PI * 2);
            ctx.stroke();
            
            // Partner name
            ctx.fillStyle = '#ffffff';
            ctx.font = '14px Arial';
            ctx.textAlign = 'center';
            const partnerName = partnerData.name.split('#')[0]; // Just the name, no tag
            ctx.fillText(partnerName, iconX, iconY + iconSize / 2 + 20);
            
            // Game count
            ctx.font = '12px Arial';
            ctx.fillStyle = '#FFD700';
            ctx.fillText(`${partnerData.count} games`, iconX, iconY + iconSize / 2 + 35);
        }
    }

    // Display LP gain/loss trend
    const startLP = climbData[0].totalLP;
    const endLP = climbData[climbData.length - 1].totalLP;
    const change = endLP - startLP;
    
    ctx.font = 'bold 24px Arial';
    ctx.textAlign = 'center';
    ctx.fillStyle = change >= 0 ? '#00FF00' : '#FF0000';
    ctx.fillText(
        `${change >= 0 ? '▲' : '▼'} ${Math.abs(change)} LP`,
        width / 2,
        height - 35
    );

    return canvas;
}