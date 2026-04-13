const { SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('bulkimport')
    .setDescription('Admin: bulk import Steam links from pasted lines')
    .addStringOption((option) =>
      option
        .setName('data')
        .setDescription('Paste one line per user: @user steamID64')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your Steam account')
    .addStringOption((option) =>
      option
        .setName('input')
        .setDescription('Steam profile link, custom URL, vanity name, or SteamID64')
        .setRequired(true)),

  new SlashCommandBuilder().setName('unlinksteam').setDescription('Unlink your Steam account'),
  new SlashCommandBuilder().setName('mylink').setDescription('Show your linked Steam account'),
  new SlashCommandBuilder().setName('refreshsteam').setDescription('Refresh your Steam name and nickname from Steam'),
  new SlashCommandBuilder().setName('verifiedlist').setDescription('Admin: list all verified users'),

  new SlashCommandBuilder()
    .setName('adminsetsteam')
    .setDescription('Admin: manually set a user Steam link')
    .addUserOption((option) => option.setName('user').setDescription('The Discord user to update').setRequired(true))
    .addStringOption((option) => option.setName('input').setDescription('Steam profile link, vanity name, or SteamID64').setRequired(true)),

  new SlashCommandBuilder()
    .setName('adminunlinksteam')
    .setDescription('Admin: manually unlink a user Steam account')
    .addUserOption((option) => option.setName('user').setDescription('The Discord user to unlink').setRequired(true)),

  new SlashCommandBuilder().setName('forcesyncsteam').setDescription('Admin: force a full Steam name sync for all linked users'),

  // Added commands
  new SlashCommandBuilder().setName('verifyhelp').setDescription('Show verification instructions'),
  new SlashCommandBuilder().setName('steamstats').setDescription('Admin: show Steam verification stats'),

  new SlashCommandBuilder()
    .setName('findsteam')
    .setDescription('Admin: find a link by Steam ID')
    .addStringOption((option) => option.setName('steamid').setDescription('SteamID64').setRequired(true)),

  new SlashCommandBuilder()
    .setName('userlink')
    .setDescription('Admin: show linked Steam info for a user')
    .addUserOption((option) => option.setName('user').setDescription('Discord user').setRequired(true)),

  new SlashCommandBuilder()
    .setName('syncusersteam')
    .setDescription('Admin: sync one user from Steam')
    .addUserOption((option) => option.setName('user').setDescription('Discord user').setRequired(true)),

  new SlashCommandBuilder().setName('restoreverified').setDescription('Admin: restore verified role/nickname for all linked members currently in server'),
  new SlashCommandBuilder().setName('orphanlinks').setDescription('Admin: show linked users not currently in the server'),
  new SlashCommandBuilder().setName('recentactions').setDescription('Admin: show recent audit actions'),
  new SlashCommandBuilder().setName('exportlinks').setDescription('Admin: export all linked users as CSV'),

  new SlashCommandBuilder()
    .setName('unlinkbysteam')
    .setDescription('Admin: unlink using a SteamID64')
    .addStringOption((option) => option.setName('steamid').setDescription('SteamID64').setRequired(true)),

  new SlashCommandBuilder()
    .setName('setbasenick')
    .setDescription('Save your preferred base nickname for Steam formatting')
    .addStringOption((option) => option.setName('name').setDescription('Base nickname (left side of |)').setRequired(true).setMaxLength(32)),

  new SlashCommandBuilder().setName('resetbasenick').setDescription('Reset your saved base nickname to your current Discord name'),

  new SlashCommandBuilder()
    .setName('renickname')
    .setDescription('Admin: re-apply nickname format for a user')
    .addUserOption((option) => option.setName('user').setDescription('Discord user').setRequired(true)),

  new SlashCommandBuilder()
    .setName('setlinknote')
    .setDescription('Admin: attach an internal note to a linked user')
    .addUserOption((option) => option.setName('user').setDescription('Discord user').setRequired(true))
    .addStringOption((option) => option.setName('note').setDescription('Internal note').setRequired(true).setMaxLength(200)),
];

const adminCommands = new Set([
  'bulkimport',
  'verifiedlist',
  'adminsetsteam',
  'adminunlinksteam',
  'forcesyncsteam',
  'steamstats',
  'findsteam',
  'userlink',
  'syncusersteam',
  'restoreverified',
  'orphanlinks',
  'recentactions',
  'exportlinks',
  'unlinkbysteam',
  'renickname',
  'setlinknote',
]);

module.exports = { commands, adminCommands };
