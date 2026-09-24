import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits, InteractionContextType, ApplicationIntegrationType } from 'discord.js';
const token=process.env.DISCORD_BOT_TOKEN, appId=process.env.DISCORD_APPLICATION_ID;
if(!token || !appId) throw new Error('Set DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID');
const commands=[
  new SlashCommandBuilder().setName('keyfi').setDescription('Set up purchase verification for your creator stores')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .addSubcommand(c=>c.setName('setup').setDescription('Connect a store and set up buyer roles'))
    .addSubcommand(c=>c.setName('create').setDescription('Create a creator verification panel'))
    .addSubcommand(c=>c.setName('edit').setDescription('Manage your stores, products, and verification panels'))
    .addSubcommand(c=>c.setName('privacy').setDescription('What Keyfi reads and stores for your stores, and the data terms'))
    .addSubcommand(c=>c.setName('map').setDescription('Search for a product and assign its buyers a role for all versions')
      .addStringOption(o=>o.setName('product').setDescription('Search products in your connected stores').setAutocomplete(true).setRequired(true))
      .addRoleOption(o=>o.setName('role').setDescription('Buyer role; the same role can be used for multiple products').setRequired(true))),
  new SlashCommandBuilder().setName('verification').setDescription('Manage purchase verification, recheck access, or delete your data')
    .setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall),
].map(c=>c.toJSON());
try {await new REST({version:'10'}).setToken(token).put(Routes.applicationCommands(appId),{body:commands});process.stdout.write('Commands registered.\n');}
catch{process.stderr.write('Command registration failed. Check application credentials.\n');process.exitCode=1;}
