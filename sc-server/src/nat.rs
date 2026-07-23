use anyhow::{Context, Result};
use std::net::SocketAddr;
use stun::message::Getter;
use tokio::net::UdpSocket;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NatType {
    Open,
    FullCone,
    RestrictedCone,
    PortRestrictedCone,
    Symmetric,
    Unknown,
}

impl NatType {
    pub fn description(&self) -> &'static str {
        match self {
            NatType::Open => "Open — no NAT, direct connections always work",
            NatType::FullCone => "Full Cone NAT — any peer can reach you",
            NatType::RestrictedCone => "Restricted Cone NAT — STUN works fine",
            NatType::PortRestrictedCone => {
                "Port-Restricted Cone NAT — STUN works, common for home routers"
            }
            NatType::Symmetric => "Symmetric NAT — needs TURN relay for remote players",
            NatType::Unknown => "Unknown — NAT check failed (no internet?)",
        }
    }

    pub fn recommended_policy(&self) -> &'static str {
        match self {
            NatType::Symmetric | NatType::Unknown => "relay",
            _ => "all",
        }
    }
}

/// Query a STUN server and return the mapped address.
async fn stun_mapped_addr(socket: &UdpSocket, server: &str) -> Result<SocketAddr> {
    let server_addr: SocketAddr = server.parse().context("invalid STUN server")?;

    let mut msg = stun::message::Message::new();
    msg.new_transaction_id()?;
    msg.build(&[Box::new(stun::message::BINDING_REQUEST)])
        .context("build STUN request")?;

    let mut buf = vec![0u8; 256];
    let n = msg
        .marshal_binary()
        .map_err(|e| anyhow::anyhow!("marshal STUN: {e}"))?;
    let len = n.len().min(buf.len());
    buf[..len].copy_from_slice(&n[..len]);

    socket.send_to(&buf[..len], server_addr).await?;

    let mut resp_buf = vec![0u8; 256];
    let (n, _src) = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        socket.recv_from(&mut resp_buf),
    )
    .await
    .context("STUN timeout")??;

    let mut resp = stun::message::Message::new();
    resp.unmarshal_binary(&resp_buf[..n])
        .map_err(|e| anyhow::anyhow!("unmarshal STUN response: {e}"))?;

    let mut xor_addr = stun::xoraddr::XorMappedAddress::default();
    xor_addr
        .get_from(&resp)
        .map_err(|e| anyhow::anyhow!("get XOR-MAPPED-ADDRESS: {e}"))?;

    Ok(SocketAddr::new(xor_addr.ip, xor_addr.port))
}

/// Classify the NAT type by comparing mapped addresses from two STUN servers.
pub async fn detect(stun_servers: &[&str]) -> Result<NatDetection> {
    let socket = UdpSocket::bind("0.0.0.0:0").await?;
    let local = socket.local_addr()?;

    let primary = if let Some(server) = stun_servers.first() {
        stun_mapped_addr(&socket, server).await
    } else {
        anyhow::bail!("no STUN servers provided");
    };

    let (mapped_addr, nat_type) = match primary {
        Ok(mapped) => {
            if is_public_ip(&mapped.ip()) {
                (mapped, NatType::Open)
            } else {
                // Try second server to detect symmetric NAT
                let nat = if let Some(second) = stun_servers.get(1) {
                    match stun_mapped_addr(&socket, second).await {
                        Ok(mapped2) => {
                            if mapped.port() != mapped2.port()
                                || mapped.ip() != mapped2.ip()
                            {
                                NatType::Symmetric
                            } else {
                                NatType::PortRestrictedCone
                            }
                        }
                        Err(_) => NatType::PortRestrictedCone,
                    }
                } else {
                    NatType::PortRestrictedCone
                };
                (mapped, nat)
            }
        }
        Err(_) => (
            SocketAddr::from(([0, 0, 0, 0], 0)),
            NatType::Unknown,
        ),
    };

    Ok(NatDetection {
        local_addr: local,
        mapped_addr,
        nat_type,
    })
}

#[derive(Debug, Clone)]
pub struct NatDetection {
    pub local_addr: SocketAddr,
    pub mapped_addr: SocketAddr,
    pub nat_type: NatType,
}

fn is_public_ip(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            !v4.is_private() && !v4.is_loopback() && !v4.is_link_local()
        }
        std::net::IpAddr::V6(v6) => !v6.is_loopback(),
    }
}
