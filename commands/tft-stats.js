const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('tft-stats')
        .setDescription('View quick statistics for a TFT summoner')
        .addStringOption(option =>
            option.setName('riotid')
                .setDescription('Riot ID (e.g., Carmite#NA1)')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('matches')
                .setDescription('Number of recent matches to analyze (5-50)')
                .setMinValue(5)
                .setMaxValue(50)
                .setRequired(false)),

    async execute(interaction) {
        await interaction.deferReply();

        const riotId = interaction.options.getString('riotid');
        const matchCount = interaction.options.getInteger('matches') || 20;
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

            // Fetch ranked stats
            const rankedRes = await fetch(
                `https://na1.api.riotgames.com/tft/league/v1/entries/by-summoner/${summoner.id}?api_key=${apiKey}`
            );
            const rankedStats = await rankedRes.json();

            // Fetch match IDs
            const matchesRes = await fetch(
                `https://americas.api.riotgames.com/tft/match/v1/matches/by-puuid/${summoner.puuid}/ids?count=${matchCount}&api_key=${apiKey}`
            );
            const matchIds = await matchesRes.json();

            if (!matchIds || matchIds.length === 0) {
                await interaction.editReply('❌ No recent matches found.');
                return;
            }

            // Analyze matches
            const stats = {
                placements: [],
                totalDamage: 0,
                totalEliminations: 0,
                levels: [],
                gameTypes: { ranked: 0, doubleUp: 0, other: 0 }
            };

            for (const matchId of matchIds) {
                const matchRes = await fetch(
                    `https://americas.api.riotgames.com/tft/match/v1/matches/${matchId}?api_key=${apiKey}`
                );
                const match = await matchRes.json();
                const playerData = match.info.participants.find(p => p.puuid === summoner.puuid);
                
                if (playerData) {
                    stats.placements.push(playerData.placement);
                    stats.totalDamage += playerData.total_damage_to_players;
                    stats.totalEliminations += playerData.players_eliminated;
                    stats.levels.push(playerData.level);

                    // Count game types
                    if (match.info.tft_game_type === 'pairs') {
                        stats.gameTypes.doubleUp++;
                    } else if (match.info.tft_game_type === 'standard') {
                        stats.gameTypes.ranked++;
                    } else {
                        stats.gameTypes.other++;
                    }
                }

                // Delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 50));
            }

            // Calculate statistics
            const avgPlacement = (stats.placements.reduce((a, b) => a + b, 0) / stats.placements.length).toFixed(2);
            const avgDamage = Math.round(stats.totalDamage / stats.placements.length);
            const avgElims = (stats.totalEliminations / stats.placements.length).toFixed(1);
            const avgLevel = (stats.levels.reduce((a, b) => a + b, 0) / stats.levels.length).toFixed(1);
            
            const top4Count = stats.placements.filter(p => p <= 4).length;
            const top4Rate = ((top4Count / stats.placements.length) * 100).toFixed(1);
            const winCount = stats.placements.filter(p => p === 1).length;
            const winRate = ((winCount / stats.placements.length) * 100).toFixed(1);

            // Placement distribution
            const placementDist = {};
            for (let i = 1; i <= 8; i++) {
                placementDist[i] = stats.placements.filter(p => p === i).length;
            }

            const distributionBar = Object.entries(placementDist)
                .map(([place, count]) => {
                    const emoji = place <= 4 ? '🟩' : '🟥';
                    const bar = emoji.repeat(Math.max(1, Math.round(count / matchIds.length * 10)));
                    return `${place}${getPlacementSuffix(place)}: ${bar} (${count})`;
                })
                .join('\n');

            // Build embed
            const rankedDisplay = rankedStats.length > 0
                ? `${rankedStats[0].tier} ${rankedStats[0].rank} - ${rankedStats[0].leaguePoints} LP`
                : 'Unranked';

            const embed = new EmbedBuilder()
                .setColor(getColorByAvgPlacement(parseFloat(avgPlacement)))
                .setAuthor({ 
                    name: `${summoner.gameName}#${summoner.tagLine}`,
                    iconURL: `http://ddragon.leagueoflegends.com/cdn/15.24.1/img/profileicon/${summoner.profileIconId}.png`
                })
                .setTitle(`📊 TFT Statistics - Last ${matchIds.length} Games`)
                .setDescription(`**Current Rank:** ${rankedDisplay}`)
                .addFields(
                    { 
                        name: '🏆 Win Stats', 
                        value: `Wins: ${winCount} (${winRate}%)\nTop 4s: ${top4Count} (${top4Rate}%)`, 
                        inline: true 
                    },
                    { 
                        name: '📈 Performance', 
                        value: `Avg Placement: ${avgPlacement}\nAvg Level: ${avgLevel}\nAvg Damage: ${avgDamage}`, 
                        inline: true 
                    },
                    { 
                        name: '⚔️ Combat', 
                        value: `Total Elims: ${stats.totalEliminations}\nAvg per Game: ${avgElims}\nTotal Damage: ${stats.totalDamage.toLocaleString()}`, 
                        inline: true 
                    },
                    {
                        name: '📍 Placement Distribution',
                        value: distributionBar,
                        inline: false
                    },
                    {
                        name: '🎮 Game Modes',
                        value: `Ranked: ${stats.gameTypes.ranked}\nDouble Up: ${stats.gameTypes.doubleUp}\nOther: ${stats.gameTypes.other}`,
                        inline: true
                    }
                )
                .setTimestamp()
                .setFooter({ text: `Analyzing ${matchIds.length} recent matches` });

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('Error fetching stats:', error);
            await interaction.editReply('❌ An error occurred while fetching statistics.');
        }
    }
};

function getPlacementSuffix(place) {
    const num = parseInt(place);
    if (num === 1) return 'st';
    if (num === 2) return 'nd';
    if (num === 3) return 'rd';
    return 'th';
}

function getColorByAvgPlacement(avg) {
    if (avg <= 3.0) return '#FFD700'; // Gold
    if (avg <= 4.0) return '#C0C0C0'; // Silver
    if (avg <= 5.0) return '#CD7F32'; // Bronze
    return '#808080'; // Gray
}